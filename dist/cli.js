#!/usr/bin/env node
"use strict";
/**
 * agent-sandbox: run AI agents inside a devcontainer with a short command.
 *
 * Usage: agent-sandbox [-w WORKSPACE] <command> [args…]
 */
Object.defineProperty(exports, "__esModule", { value: true });
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_os_1 = require("node:os");
const node_fs_1 = require("node:fs");
const node_readline_1 = require("node:readline");
const node_path_1 = require("node:path");
const which_1 = require("./which");
const init_1 = require("./init");
const appium_host_1 = require("./appium-host");
// docker must be present at startup; devcontainer is auto-installed on first use.
const DOCKER = (0, which_1.which)("docker");
let _devcontainer = null;
function getDevcontainer() {
    if (!_devcontainer)
        _devcontainer = (0, which_1.which)("devcontainer");
    return _devcontainer;
}
/** Walk up from start until a real (non-symlink) .devcontainer/ directory is found. */
function findWorkspace(start) {
    let current = (0, node_fs_1.realpathSync)(start);
    while (true) {
        const candidate = (0, node_path_1.join)(current, ".devcontainer");
        if ((0, node_fs_1.existsSync)(candidate)) {
            const stat = (0, node_fs_1.lstatSync)(candidate);
            if (stat.isDirectory() && !stat.isSymbolicLink()) {
                return current;
            }
        }
        const parent = (0, node_path_1.dirname)(current);
        if (parent === current) {
            throw new Error(`error: could not find a .devcontainer/ directory in ${start} or any parent directory.\n` +
                `Run 'agent-sandbox init' first to set up the devcontainer configuration.`);
        }
        current = parent;
    }
}
/** Return true if a devcontainer for this workspace is already running. */
function containerIsRunning(workspace) {
    const result = (0, node_child_process_1.spawnSync)(DOCKER, [
        "ps",
        "--filter", `label=devcontainer.local_folder=${workspace}`,
        "--format", "{{.ID}}",
    ], { encoding: "utf8" });
    return result.stdout.trim().length > 0;
}
function workspaceContainerIds(workspace) {
    const result = (0, node_child_process_1.spawnSync)(DOCKER, [
        "ps", "-a", "-q",
        "--filter", `label=devcontainer.local_folder=${workspace}`,
    ], { encoding: "utf8" });
    return result.stdout.trim().split("\n").filter(Boolean);
}
function sleep(milliseconds) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
/**
 * Spawn a detached watchdog process that monitors our PID.
 * If this process disappears (e.g. SIGKILL), the watchdog stops the container.
 * Returns the watchdog PID so it can be killed on normal exit.
 */
function spawnWatchdog(workspace) {
    const parentPid = process.pid;
    // Inline Node.js script that polls whether the parent is still alive.
    const script = `
    const { spawnSync } = require("child_process");
    const pid = ${parentPid};
    const workspace = ${JSON.stringify(workspace)};
    const docker = ${JSON.stringify(DOCKER)};
    const interval = setInterval(() => {
      try { process.kill(pid, 0); } catch {
        // Parent is gone — stop the container.
        const r = spawnSync(docker, [
          "ps", "-q", "--filter", "label=devcontainer.local_folder=" + workspace
        ], { encoding: "utf8" });
        const ids = r.stdout.trim().split("\\n").filter(Boolean);
        if (ids.length > 0) spawnSync(docker, ["stop", ...ids]);
        clearInterval(interval);
        process.exit(0);
      }
    }, 2000);
  `;
    const child = (0, node_child_process_1.spawn)(process.execPath, ["-e", script], {
        detached: true,
        stdio: "ignore",
    });
    child.unref();
    return child.pid;
}
function lockOwnerIsAlive(lockDir) {
    try {
        const pid = Number((0, node_fs_1.readFileSync)((0, node_path_1.join)(lockDir, "owner"), "utf8").split("\n")[0]);
        return Number.isInteger(pid) && pid > 0 && process.kill(pid, 0);
    }
    catch {
        return false;
    }
}
function acquireWorkspaceLock(workspace) {
    const lockDir = (0, node_path_1.join)(workspace, ".devcontainer", ".agent-sandbox-up.lock");
    const started = Date.now();
    const waitTimeoutMs = 30 * 60 * 1000;
    const staleAfterMs = 60 * 60 * 1000;
    while (true) {
        try {
            (0, node_fs_1.mkdirSync)(lockDir);
            (0, node_fs_1.writeFileSync)((0, node_path_1.join)(lockDir, "owner"), `${process.pid}\n${new Date().toISOString()}\n`);
            return () => (0, node_fs_1.rmSync)(lockDir, { recursive: true, force: true });
        }
        catch (err) {
            if (!err || typeof err !== "object" || !("code" in err) || err.code !== "EEXIST") {
                throw err;
            }
            const ageMs = Date.now() - (0, node_fs_1.lstatSync)(lockDir).mtimeMs;
            if (!lockOwnerIsAlive(lockDir) || ageMs > staleAfterMs) {
                (0, node_fs_1.rmSync)(lockDir, { recursive: true, force: true });
                continue;
            }
            if (Date.now() - started > waitTimeoutMs) {
                throw new Error(`Timed out waiting for devcontainer startup lock: ${lockDir}`);
            }
            sleep(500);
        }
    }
}
function stableCacheTag(workspace) {
    // Prefer build.cacheFrom from generated devcontainer.json.
    const devcontainerJson = (0, node_path_1.join)(workspace, ".devcontainer", "devcontainer.json");
    if ((0, node_fs_1.existsSync)(devcontainerJson)) {
        try {
            const parsed = JSON.parse((0, node_fs_1.readFileSync)(devcontainerJson, "utf8"));
            const cacheFrom = parsed?.build?.cacheFrom;
            if (Array.isArray(cacheFrom)) {
                const tag = cacheFrom.find((entry) => typeof entry === "string" && entry.startsWith("agent-sandbox-devcontainer:"));
                if (tag)
                    return tag;
            }
        }
        catch {
            // Fall through to Dockerfile-based detection.
        }
    }
    const dockerfile = (0, node_path_1.join)(workspace, ".devcontainer", "Dockerfile");
    if ((0, node_fs_1.existsSync)(dockerfile)) {
        const content = (0, node_fs_1.readFileSync)(dockerfile, "utf8");
        // New marker emitted by init: "# agent-sandbox-installs: a,b,c"
        const markerMatch = content.match(/^#\s*agent-sandbox-installs:\s*(.*)$/m);
        if (markerMatch) {
            const list = markerMatch[1]
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
                .sort();
            const profile = list.length === 0 ? "base" : list.join("--");
            return `agent-sandbox-devcontainer:${profile}`;
        }
        // Legacy fallback for workspaces generated before the layer refactor.
        if (content.includes("mcr.microsoft.com/playwright")) {
            return "agent-sandbox-devcontainer:playwright-cli";
        }
    }
    return "agent-sandbox-devcontainer:base";
}
// --- .devcontainer change detection ---
const STATE_FILE = ".agent-sandbox-state.json";
/** Recursively collect all files under a directory (excluding the state file and lock). */
function collectFiles(dir, base) {
    const entries = [];
    for (const entry of (0, node_fs_1.readdirSync)(dir, { withFileTypes: true })) {
        const full = (0, node_path_1.join)(dir, entry.name);
        if (entry.name === STATE_FILE)
            continue;
        if (entry.name === ".agent-sandbox-up.lock")
            continue;
        if (entry.isDirectory()) {
            entries.push(...collectFiles(full, base));
        }
        else if (entry.isFile()) {
            entries.push((0, node_path_1.relative)(base, full));
        }
    }
    return entries.sort();
}
/** Compute a combined hash of all files under .devcontainer/. */
function computeDevcontainerHash(workspace) {
    const devcontainerDir = (0, node_path_1.join)(workspace, ".devcontainer");
    const files = collectFiles(devcontainerDir, devcontainerDir);
    const hash = (0, node_crypto_1.createHash)("sha256");
    for (const file of files) {
        hash.update(file);
        hash.update((0, node_fs_1.readFileSync)((0, node_path_1.join)(devcontainerDir, file)));
    }
    return hash.digest("hex");
}
/** Read the saved state hash, or null if not recorded yet. */
function readSavedHash(workspace) {
    const stateFile = (0, node_path_1.join)(workspace, ".devcontainer", STATE_FILE);
    if (!(0, node_fs_1.existsSync)(stateFile))
        return null;
    try {
        const data = JSON.parse((0, node_fs_1.readFileSync)(stateFile, "utf8"));
        return typeof data.hash === "string" ? data.hash : null;
    }
    catch {
        return null;
    }
}
/** Save the current devcontainer hash. */
function saveDevcontainerHash(workspace) {
    const stateFile = (0, node_path_1.join)(workspace, ".devcontainer", STATE_FILE);
    const hash = computeDevcontainerHash(workspace);
    (0, node_fs_1.writeFileSync)(stateFile, JSON.stringify({ hash, updatedAt: new Date().toISOString() }) + "\n");
}
/** Prompt the user with a yes/no question. Returns true if confirmed. */
function promptConfirm(message) {
    const rl = (0, node_readline_1.createInterface)({ input: process.stdin, output: process.stderr });
    return new Promise((resolve) => {
        rl.question(message, (answer) => {
            rl.close();
            resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
        });
    });
}
/** Check if .devcontainer files changed and prompt for rebuild if needed. Returns true if clean was performed. */
async function checkDevcontainerChanged(workspace) {
    const savedHash = readSavedHash(workspace);
    if (savedHash === null) {
        const containerIds = workspaceContainerIds(workspace);
        if (containerIds.length > 0) {
            process.stderr.write("[agent-sandbox] No devcontainer state file found, removing stale container(s) before first build.\n");
            cleanWorkspace(workspace);
            return true;
        }
        return false;
    }
    const currentHash = computeDevcontainerHash(workspace);
    if (currentHash === savedHash)
        return false;
    process.stderr.write("[agent-sandbox] Detected changes in .devcontainer/ since last build.\n");
    const confirmed = await promptConfirm("[agent-sandbox] Clean and rebuild the container? [y/N]: ");
    if (confirmed) {
        cleanWorkspace(workspace);
        return true;
    }
    // User declined — update saved hash so we don't ask again for the same changes.
    saveDevcontainerHash(workspace);
    return false;
}
function runningContainerImage(workspace) {
    const result = (0, node_child_process_1.spawnSync)(DOCKER, [
        "ps",
        "--filter", `label=devcontainer.local_folder=${workspace}`,
        "--format", "{{.Image}}",
    ], { encoding: "utf8" });
    return result.stdout.trim().split("\n").filter(Boolean)[0] ?? null;
}
function tagStableCacheImage(workspace) {
    const image = runningContainerImage(workspace);
    if (!image)
        return;
    const tag = stableCacheTag(workspace);
    const result = (0, node_child_process_1.spawnSync)(DOCKER, ["tag", image, tag], { stdio: "inherit" });
    if (result.status === 0) {
        process.stderr.write(`[agent-sandbox] Tagged reusable cache image: ${tag}\n`);
    }
}
/** Start the devcontainer if it is not already running. */
function ensureContainer(workspace, options) {
    if (containerIsRunning(workspace))
        return;
    const releaseLock = acquireWorkspaceLock(workspace);
    try {
        if (containerIsRunning(workspace))
            return;
        process.stderr.write(`[agent-sandbox] Container not running, starting devcontainer at ${workspace} …\n`);
        const args = ["up", "--workspace-folder", workspace];
        if (options?.noCache) {
            args.push("--build-no-cache");
        }
        (0, node_child_process_1.execFileSync)(getDevcontainer(), args, {
            stdio: "inherit",
        });
        tagStableCacheImage(workspace);
        saveDevcontainerHash(workspace);
    }
    finally {
        releaseLock();
    }
}
/** Show status of devcontainer(s) for the given workspace. */
function showStatus(workspace) {
    const result = (0, node_child_process_1.spawnSync)(DOCKER, [
        "ps", "-a",
        "--filter", `label=devcontainer.local_folder=${workspace}`,
        "--format", "table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Image}}",
    ], { encoding: "utf8" });
    const output = result.stdout.trim();
    if (!output || output === "CONTAINER ID   NAMES   STATUS   IMAGE") {
        process.stdout.write(`[agent-sandbox] No container found for ${workspace}\n`);
    }
    else {
        process.stdout.write(output + "\n");
    }
    // LLM configuration summary.
    const resolved = resolveLlmEnv(workspace);
    process.stdout.write("\nLLM configuration:\n");
    for (const key of [LLM_KEYS.url, LLM_KEYS.type, LLM_KEYS.model]) {
        const value = resolved.values[key];
        if (value === undefined) {
            process.stdout.write(`  ${key}: (unset)\n`);
        }
        else {
            process.stdout.write(`  ${key}: ${value} ${sourceLabel(workspace, resolved.sources[key])}\n`);
        }
    }
}
function stopContainers(workspace) {
    const result = (0, node_child_process_1.spawnSync)(DOCKER, [
        "ps", "-q",
        "--filter", `label=devcontainer.local_folder=${workspace}`,
    ], { encoding: "utf8" });
    const ids = result.stdout.trim().split("\n").filter(Boolean);
    if (ids.length === 0) {
        process.stdout.write(`[agent-sandbox] No running container found for ${workspace}\n`);
        return;
    }
    process.stdout.write(`[agent-sandbox] Stopping container(s): ${ids.join(", ")} …\n`);
    (0, node_child_process_1.spawnSync)(DOCKER, ["stop", ...ids], { stdio: "inherit" });
    process.stdout.write("[agent-sandbox] Container(s) stopped.\n");
}
function cleanWorkspace(workspace) {
    // 1. Find ALL containers (running + stopped) for this workspace.
    const containerIds = workspaceContainerIds(workspace);
    // Collect image IDs before removing containers (so we can remove dangling images).
    const imageResult = (0, node_child_process_1.spawnSync)(DOCKER, [
        "ps", "-a",
        "--filter", `label=devcontainer.local_folder=${workspace}`,
        "--format", "{{.Image}}",
    ], { encoding: "utf8" });
    const containerImages = new Set(imageResult.stdout.trim().split("\n").filter(Boolean));
    if (containerIds.length > 0) {
        process.stdout.write(`[agent-sandbox] Removing ${containerIds.length} container(s): ${containerIds.join(", ")} …\n`);
        (0, node_child_process_1.spawnSync)(DOCKER, ["rm", "-f", ...containerIds], { stdio: "inherit" });
    }
    else {
        process.stdout.write("[agent-sandbox] No containers found for this workspace.\n");
    }
    // 2. Remove images that were used by this workspace's containers + our cache tag.
    //    Only removes images we can positively associate with this workspace via
    //    container labels or our own cache tag — never pattern-matches by name alone.
    const imagesToRemove = [...containerImages];
    const cacheTag = stableCacheTag(workspace);
    const cacheResult = (0, node_child_process_1.spawnSync)(DOCKER, [
        "images", "-q", cacheTag,
    ], { encoding: "utf8" });
    const cacheId = cacheResult.stdout.trim();
    if (cacheId)
        imagesToRemove.push(cacheId);
    const uniqueImages = [...new Set(imagesToRemove)];
    if (uniqueImages.length > 0) {
        process.stdout.write(`[agent-sandbox] Removing ${uniqueImages.length} image(s) …\n`);
        (0, node_child_process_1.spawnSync)(DOCKER, ["rmi", "-f", ...uniqueImages], { stdio: "inherit" });
    }
    else {
        process.stdout.write("[agent-sandbox] No related images found.\n");
    }
    process.stdout.write("[agent-sandbox] Clean complete.\n");
}
/** Remove containers, images, volumes, and Docker build cache for a full rebuild from scratch. */
function distcleanWorkspace(workspace) {
    cleanWorkspace(workspace);
    // Remove volumes associated with this workspace's devcontainer.
    const volumeResult = (0, node_child_process_1.spawnSync)(DOCKER, [
        "volume", "ls", "-q",
        "--filter", `label=devcontainer.local_folder=${workspace}`,
    ], { encoding: "utf8" });
    const volumeIds = volumeResult.stdout.trim().split("\n").filter(Boolean);
    if (volumeIds.length > 0) {
        process.stdout.write(`[agent-sandbox] Removing ${volumeIds.length} volume(s) …\n`);
        (0, node_child_process_1.spawnSync)(DOCKER, ["volume", "rm", "-f", ...volumeIds], { stdio: "inherit" });
    }
    // Prune builder cache for devcontainer builds.
    process.stdout.write("[agent-sandbox] Pruning Docker build cache …\n");
    (0, node_child_process_1.spawnSync)(DOCKER, ["builder", "prune", "-f"], { stdio: "inherit" });
    // Remove state file so next build is treated as fresh.
    const stateFile = (0, node_path_1.join)(workspace, ".devcontainer", STATE_FILE);
    if ((0, node_fs_1.existsSync)(stateFile)) {
        (0, node_fs_1.rmSync)(stateFile);
        process.stdout.write("[agent-sandbox] Removed build state file.\n");
    }
    process.stdout.write("[agent-sandbox] Distclean complete.\n");
}
// === LLM environment configuration ===
const LLM_KEYS = {
    url: "COPILOT_PROVIDER_BASE_URL",
    type: "COPILOT_PROVIDER_TYPE",
    model: "COPILOT_MODEL",
};
function hostLlmEnvPath() {
    return (0, node_path_1.join)((0, node_os_1.homedir)(), ".agent-sandbox", "llm.env");
}
function projectLlmEnvPath(workspace) {
    return (0, node_path_1.join)(workspace, ".agent-sandbox", "llm.env");
}
function parseEnvFile(path) {
    if (!(0, node_fs_1.existsSync)(path))
        return {};
    const env = {};
    for (const line of (0, node_fs_1.readFileSync)(path, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#"))
            continue;
        const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match)
            continue;
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        env[match[1]] = value;
    }
    return env;
}
/** Resolve effective LLM env values with their source. */
function resolveLlmEnv(workspace) {
    const hostEnv = parseEnvFile(hostLlmEnvPath());
    const projectEnv = workspace ? parseEnvFile(projectLlmEnvPath(workspace)) : {};
    const values = {};
    const sources = {};
    const keys = new Set([
        ...Object.keys(hostEnv),
        ...Object.keys(projectEnv),
    ]);
    for (const key of keys) {
        if (process.env[key] !== undefined) {
            values[key] = process.env[key];
            sources[key] = "process";
        }
        else if (key in projectEnv) {
            values[key] = projectEnv[key];
            sources[key] = "project";
        }
        else {
            values[key] = hostEnv[key];
            sources[key] = "host";
        }
    }
    return { values, sources };
}
function llmEnvForExec(workspace) {
    return resolveLlmEnv(workspace).values;
}
/**
 * Write or update env entries in a file, preserving comments and other lines.
 * Creates the file (and parent dir) if missing.
 */
function writeEnvValues(path, entries) {
    (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(path), { recursive: true });
    const existing = (0, node_fs_1.existsSync)(path) ? (0, node_fs_1.readFileSync)(path, "utf8") : "";
    const lines = existing.split(/\r?\n/);
    const remaining = new Set(Object.keys(entries));
    const updated = lines.map((line) => {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#"))
            return line;
        const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/);
        if (!match)
            return line;
        const key = match[1];
        if (!(key in entries))
            return line;
        remaining.delete(key);
        return `${key}=${entries[key]}`;
    });
    // Drop a trailing empty line if present so appending is tidy.
    while (updated.length > 0 && updated[updated.length - 1] === "") {
        updated.pop();
    }
    for (const key of remaining) {
        updated.push(`${key}=${entries[key]}`);
    }
    (0, node_fs_1.writeFileSync)(path, updated.join("\n") + "\n");
}
function execInContainer(workspace, command) {
    const envArgs = Object.entries(llmEnvForExec(workspace)).map(([key, value]) => `${key}=${value}`);
    const wrappedCommand = envArgs.length > 0 ? ["env", ...envArgs, ...command] : command;
    const result = (0, node_child_process_1.spawnSync)(getDevcontainer(), ["exec", "--workspace-folder", workspace, ...wrappedCommand], { stdio: "inherit" });
    return result.status ?? 1;
}
// === LLM config subcommands ===
function sourceLabel(workspace, source) {
    switch (source) {
        case "process":
            return "(from process env)";
        case "project":
            return workspace
                ? `(from ${projectLlmEnvPath(workspace)})`
                : "(from project)";
        case "host":
            return `(from ${hostLlmEnvPath()})`;
        case "unset":
            return "(unset)";
    }
}
function targetEnvPath(workspace, global) {
    return global ? hostLlmEnvPath() : projectLlmEnvPath(workspace);
}
function validateUrl(value) {
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        throw new Error(`error: invalid URL: ${value}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`error: URL must use http:// or https:// (got ${parsed.protocol})`);
    }
    // Normalize: strip trailing slashes.
    return value.replace(/\/+$/, "");
}
/** Compute the OpenAI-compatible /models endpoint from a base URL. */
function modelsEndpoint(baseUrl) {
    const trimmed = baseUrl.replace(/\/+$/, "");
    if (/\/v\d+$/i.test(trimmed)) {
        return `${trimmed}/models`;
    }
    return `${trimmed}/v1/models`;
}
function parseGlobalFlag(args) {
    const rest = [];
    let global = false;
    for (const arg of args) {
        if (arg === "--global" || arg === "-g") {
            global = true;
        }
        else {
            rest.push(arg);
        }
    }
    return { rest, global };
}
function handleUrlCommand(workspace, args) {
    const { rest, global } = parseGlobalFlag(args);
    const resolved = resolveLlmEnv(workspace);
    if (rest.length === 0) {
        const value = resolved.values[LLM_KEYS.url];
        if (value) {
            process.stdout.write(`${value} ${sourceLabel(workspace, resolved.sources[LLM_KEYS.url])}\n`);
        }
        else {
            process.stdout.write(`${LLM_KEYS.url} is unset\n`);
        }
        return;
    }
    if (rest.length > 1) {
        throw new Error("error: agent-sandbox url accepts at most one URL argument");
    }
    const url = validateUrl(rest[0]);
    const path = targetEnvPath(workspace, global);
    writeEnvValues(path, {
        [LLM_KEYS.url]: url,
        [LLM_KEYS.type]: "openai",
    });
    process.stdout.write(`[agent-sandbox] Set ${LLM_KEYS.url}=${url} in ${path}\n`);
    process.stdout.write(`[agent-sandbox] Set ${LLM_KEYS.type}=openai in ${path}\n`);
}
function handleModelCommand(workspace, args) {
    const { rest, global } = parseGlobalFlag(args);
    const resolved = resolveLlmEnv(workspace);
    if (rest.length === 0) {
        const value = resolved.values[LLM_KEYS.model];
        if (value) {
            process.stdout.write(`${value} ${sourceLabel(workspace, resolved.sources[LLM_KEYS.model])}\n`);
        }
        else {
            process.stdout.write(`${LLM_KEYS.model} is unset\n`);
        }
        return;
    }
    if (rest.length > 1) {
        throw new Error("error: agent-sandbox model accepts at most one model argument");
    }
    const model = rest[0].trim();
    if (model === "") {
        throw new Error("error: model name must not be empty");
    }
    const path = targetEnvPath(workspace, global);
    writeEnvValues(path, { [LLM_KEYS.model]: model });
    process.stdout.write(`[agent-sandbox] Set ${LLM_KEYS.model}=${model} in ${path}\n`);
}
async function handleModelsCommand(workspace, args) {
    let overrideUrl = null;
    const rest = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--url" && i + 1 < args.length) {
            overrideUrl = args[++i];
        }
        else if (args[i].startsWith("--url=")) {
            overrideUrl = args[i].slice("--url=".length);
        }
        else {
            rest.push(args[i]);
        }
    }
    if (rest.length > 0) {
        throw new Error(`error: unexpected argument(s): ${rest.join(", ")}`);
    }
    const resolved = resolveLlmEnv(workspace);
    const baseUrl = overrideUrl
        ? validateUrl(overrideUrl)
        : resolved.values[LLM_KEYS.url];
    if (!baseUrl) {
        throw new Error(`error: no ${LLM_KEYS.url} configured. Set one with:\n` +
            `  agent-sandbox url http://host:8000/v1\n` +
            `Or pass --url <url> to query a one-off endpoint.`);
    }
    const endpoint = modelsEndpoint(baseUrl);
    process.stderr.write(`[agent-sandbox] Fetching ${endpoint} …\n`);
    let response;
    try {
        response = await fetch(endpoint);
    }
    catch (err) {
        throw new Error(`error: failed to reach ${endpoint}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!response.ok) {
        throw new Error(`error: ${endpoint} returned HTTP ${response.status}`);
    }
    let body;
    try {
        body = await response.json();
    }
    catch {
        throw new Error(`error: ${endpoint} did not return valid JSON`);
    }
    const data = body?.data;
    if (!Array.isArray(data)) {
        throw new Error(`error: unexpected response shape from ${endpoint}; expected {"data":[...]}`);
    }
    const ids = [];
    for (const entry of data) {
        if (entry && typeof entry === "object" && typeof entry.id === "string") {
            ids.push(entry.id);
        }
    }
    if (ids.length === 0) {
        process.stdout.write("[agent-sandbox] No models returned.\n");
        return;
    }
    const activeModel = resolved.values[LLM_KEYS.model];
    for (const id of ids) {
        const marker = id === activeModel ? "* " : "  ";
        process.stdout.write(`${marker}${id}\n`);
    }
}
function printUsage() {
    process.stderr.write("usage: agent-sandbox <subcommand> [args…]\n" +
        "\n" +
        "Subcommands:\n" +
        "  init [-f|--force] [--install=<targets>]\n" +
        "                             Scaffold .devcontainer/ into the current directory.\n" +
        "                             Targets: playwright-cli, appium-cli\n" +
        "                             (comma-separated or repeat --install=...)\n" +
        "  status                     Show container status and active LLM configuration\n" +
        "  stop                       Stop the running devcontainer\n" +
        "  clean                      Remove containers and old images for this workspace\n" +
        "  distclean                  clean + remove volumes and Docker build cache\n" +
        "  rebuild                    distclean + rebuild the container from scratch\n" +
        "  url [<url>] [--global]     Show or set COPILOT_PROVIDER_BASE_URL (also sets\n" +
        "                             COPILOT_PROVIDER_TYPE=openai). Writes to project\n" +
        "                             .agent-sandbox/llm.env by default; --global writes\n" +
        "                             to ~/.agent-sandbox/llm.env.\n" +
        "  model [<model>] [--global] Show or set COPILOT_MODEL (same precedence rules).\n" +
        "  models [--url <url>]       List models from the OpenAI-compatible endpoint.\n" +
        "\n" +
        "Agent commands (run inside devcontainer):\n" +
        "  copilot --allow-all -p 'fix all failing tests'\n" +
        "  claude --dangerously-skip-permissions -p 'run tests'\n" +
        "  playwright-cli open https://example.com     (requires --install=playwright-cli)\n" +
        "  appium-cli doctor                            (requires --install=appium-cli)\n" +
        "\n" +
        "Options:\n" +
        "  -w, --workspace PATH       Specify workspace folder explicitly\n" +
        "\n" +
        "Examples:\n" +
        "  agent-sandbox init\n" +
        "  agent-sandbox init --install=playwright-cli\n" +
        "  agent-sandbox status\n" +
        "  agent-sandbox stop\n" +
        "  agent-sandbox distclean\n" +
        "  agent-sandbox rebuild\n" +
        "  agent-sandbox url http://llm.example.com:8000/v1\n" +
        "  agent-sandbox url http://llm.example.com:8000/v1 --global\n" +
        "  agent-sandbox model Qwen3.5-9B-bf16\n" +
        "  agent-sandbox models\n" +
        "  agent-sandbox models --url http://llm.example.com:8000/v1\n" +
        "  agent-sandbox copilot --allow-all -p 'fix all failing tests'\n" +
        "  agent-sandbox claude --dangerously-skip-permissions -p 'run tests'\n" +
        "  agent-sandbox -w /path/to/project copilot -p 'review code'\n");
}
async function main() {
    const args = process.argv.slice(2);
    let workspaceOverride = null;
    const filtered = [];
    for (let i = 0; i < args.length; i++) {
        if ((args[i] === "--workspace" || args[i] === "-w") && i + 1 < args.length) {
            // resolve() converts relative paths to absolute paths.
            workspaceOverride = (0, node_path_1.resolve)(args[++i]);
        }
        else {
            filtered.push(args[i]);
        }
    }
    if (filtered.length === 0) {
        printUsage();
        process.exit(1);
    }
    // init subcommand: scaffold devcontainer config, no container needed
    if (filtered[0] === "init") {
        (0, init_1.runInit)(filtered.slice(1));
        return;
    }
    // appium subcommand: host-side Appium lifecycle (no container needed).
    // Usage: agent-sandbox appium host <start|stop|status|log> [args]
    if (filtered[0] === "appium") {
        const sub = filtered[1];
        const rest = filtered.slice(2);
        if (sub === "host") {
            try {
                await (0, appium_host_1.runAppiumHost)(rest);
            }
            catch (err) {
                process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
                process.exit(1);
            }
            return;
        }
        process.stderr.write("usage: agent-sandbox appium host <start|stop|status|log> [args]\n");
        process.exit(1);
    }
    // status subcommand: show container name and status
    if (filtered[0] === "status") {
        try {
            const workspace = workspaceOverride ?? findWorkspace(process.cwd());
            showStatus(workspace);
        }
        catch (err) {
            process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
            process.exit(1);
        }
        return;
    }
    // stop subcommand: stop running container(s) for this workspace
    if (filtered[0] === "stop") {
        try {
            const workspace = workspaceOverride ?? findWorkspace(process.cwd());
            stopContainers(workspace);
        }
        catch (err) {
            process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
            process.exit(1);
        }
        return;
    }
    // clean subcommand: remove stopped containers + old images for this workspace
    if (filtered[0] === "clean") {
        try {
            const workspace = workspaceOverride ?? findWorkspace(process.cwd());
            cleanWorkspace(workspace);
        }
        catch (err) {
            process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
            process.exit(1);
        }
        return;
    }
    // distclean subcommand: clean + remove volumes and build cache
    if (filtered[0] === "distclean") {
        try {
            const workspace = workspaceOverride ?? findWorkspace(process.cwd());
            distcleanWorkspace(workspace);
        }
        catch (err) {
            process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
            process.exit(1);
        }
        return;
    }
    // rebuild subcommand: distclean + build fresh container
    if (filtered[0] === "rebuild") {
        try {
            const workspace = workspaceOverride ?? findWorkspace(process.cwd());
            distcleanWorkspace(workspace);
            process.stderr.write("[agent-sandbox] Rebuilding devcontainer from scratch …\n");
            ensureContainer(workspace, { noCache: true });
            process.stdout.write("[agent-sandbox] Rebuild complete.\n");
        }
        catch (err) {
            process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
            process.exit(1);
        }
        return;
    }
    // url subcommand: show/set COPILOT_PROVIDER_BASE_URL
    if (filtered[0] === "url") {
        try {
            const workspace = workspaceOverride ?? findWorkspace(process.cwd());
            handleUrlCommand(workspace, filtered.slice(1));
        }
        catch (err) {
            process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
            process.exit(1);
        }
        return;
    }
    // model subcommand: show/set COPILOT_MODEL
    if (filtered[0] === "model") {
        try {
            const workspace = workspaceOverride ?? findWorkspace(process.cwd());
            handleModelCommand(workspace, filtered.slice(1));
        }
        catch (err) {
            process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
            process.exit(1);
        }
        return;
    }
    // models subcommand: list models from the OpenAI-compatible endpoint
    if (filtered[0] === "models") {
        try {
            const workspace = workspaceOverride ?? findWorkspace(process.cwd());
            await handleModelsCommand(workspace, filtered.slice(1));
        }
        catch (err) {
            process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
            process.exit(1);
        }
        return;
    }
    try {
        const workspace = workspaceOverride ?? findWorkspace(process.cwd());
        await checkDevcontainerChanged(workspace);
        // Stop orphaned container from a previous run (e.g. after SIGKILL).
        if (containerIsRunning(workspace)) {
            process.stderr.write("[agent-sandbox] Stopping orphaned container from previous run …\n");
            stopContainers(workspace);
        }
        ensureContainer(workspace);
        // Watchdog: if this process is killed (e.g. SIGKILL), the detached
        // watchdog will detect parent death and stop the container.
        const watchdogPid = spawnWatchdog(workspace);
        // Register cleanup to stop the container on exit or signal.
        let cleaned = false;
        const cleanup = () => {
            if (cleaned)
                return;
            cleaned = true;
            // Kill the watchdog — no longer needed on graceful exit.
            if (watchdogPid) {
                try {
                    process.kill(watchdogPid);
                }
                catch { /* already gone */ }
            }
            try {
                stopContainers(workspace);
            }
            catch {
                // Best-effort cleanup; ignore errors.
            }
        };
        process.on("SIGINT", () => { cleanup(); process.exit(130); });
        process.on("SIGTERM", () => { cleanup(); process.exit(143); });
        const exitCode = execInContainer(workspace, filtered);
        cleanup();
        process.exit(exitCode);
    }
    catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
    }
}
main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
});
