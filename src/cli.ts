#!/usr/bin/env node
/**
 * agent-sandbox: run AI agents inside a devcontainer with a short command.
 *
 * Usage: agent-sandbox [-w WORKSPACE] <command> [args…]
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  realpathSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { resolve, dirname, join, relative } from "node:path";
import { which } from "./which";
import { runInit } from "./init";

// docker must be present at startup; devcontainer is auto-installed on first use.
const DOCKER = which("docker");
let _devcontainer: string | null = null;
function getDevcontainer(): string {
  if (!_devcontainer) _devcontainer = which("devcontainer");
  return _devcontainer;
}

/** Walk up from start until a real (non-symlink) .devcontainer/ directory is found. */
function findWorkspace(start: string): string {
  let current = realpathSync(start);
  while (true) {
    const candidate = join(current, ".devcontainer");
    if (existsSync(candidate)) {
      const stat = lstatSync(candidate);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        return current;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `error: could not find a .devcontainer/ directory in ${start} or any parent directory.\n` +
        `Run 'agent-sandbox init' first to set up the devcontainer configuration.`
      );
    }
    current = parent;
  }
}

/** Return true if a devcontainer for this workspace is already running. */
function containerIsRunning(workspace: string): boolean {
  const result = spawnSync(DOCKER, [
    "ps",
    "--filter", `label=devcontainer.local_folder=${workspace}`,
    "--format", "{{.ID}}",
  ], { encoding: "utf8" });
  return result.stdout.trim().length > 0;
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Spawn a detached watchdog process that monitors our PID.
 * If this process disappears (e.g. SIGKILL), the watchdog stops the container.
 * Returns the watchdog PID so it can be killed on normal exit.
 */
function spawnWatchdog(workspace: string): number | undefined {
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
  const child = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid;
}

function lockOwnerIsAlive(lockDir: string): boolean {
  try {
    const pid = Number(readFileSync(join(lockDir, "owner"), "utf8").split("\n")[0]);
    return Number.isInteger(pid) && pid > 0 && process.kill(pid, 0);
  } catch {
    return false;
  }
}

function acquireWorkspaceLock(workspace: string): () => void {
  const lockDir = join(workspace, ".devcontainer", ".agent-sandbox-up.lock");
  const started = Date.now();
  const waitTimeoutMs = 30 * 60 * 1000;
  const staleAfterMs = 60 * 60 * 1000;

  while (true) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "owner"), `${process.pid}\n${new Date().toISOString()}\n`);
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch (err) {
      if (!err || typeof err !== "object" || !("code" in err) || err.code !== "EEXIST") {
        throw err;
      }

      const ageMs = Date.now() - lstatSync(lockDir).mtimeMs;
      if (!lockOwnerIsAlive(lockDir) || ageMs > staleAfterMs) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }

      if (Date.now() - started > waitTimeoutMs) {
        throw new Error(`Timed out waiting for devcontainer startup lock: ${lockDir}`);
      }
      sleep(500);
    }
  }
}

function stableCacheTag(workspace: string): string {
  // Prefer build.cacheFrom from generated devcontainer.json.
  const devcontainerJson = join(workspace, ".devcontainer", "devcontainer.json");
  if (existsSync(devcontainerJson)) {
    try {
      const parsed = JSON.parse(readFileSync(devcontainerJson, "utf8"));
      const cacheFrom: unknown = parsed?.build?.cacheFrom;
      if (Array.isArray(cacheFrom)) {
        const tag = cacheFrom.find(
          (entry): entry is string =>
            typeof entry === "string" && entry.startsWith("agent-sandbox-devcontainer:")
        );
        if (tag) return tag;
      }
    } catch {
      // Fall through to Dockerfile-based detection.
    }
  }

  const dockerfile = join(workspace, ".devcontainer", "Dockerfile");
  if (existsSync(dockerfile)) {
    const content = readFileSync(dockerfile, "utf8");
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
function collectFiles(dir: string, base: string): string[] {
  const entries: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.name === STATE_FILE) continue;
    if (entry.name === ".agent-sandbox-up.lock") continue;
    if (entry.isDirectory()) {
      entries.push(...collectFiles(full, base));
    } else if (entry.isFile()) {
      entries.push(relative(base, full));
    }
  }
  return entries.sort();
}

/** Compute a combined hash of all files under .devcontainer/. */
function computeDevcontainerHash(workspace: string): string {
  const devcontainerDir = join(workspace, ".devcontainer");
  const files = collectFiles(devcontainerDir, devcontainerDir);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update(readFileSync(join(devcontainerDir, file)));
  }
  return hash.digest("hex");
}

/** Read the saved state hash, or null if not recorded yet. */
function readSavedHash(workspace: string): string | null {
  const stateFile = join(workspace, ".devcontainer", STATE_FILE);
  if (!existsSync(stateFile)) return null;
  try {
    const data = JSON.parse(readFileSync(stateFile, "utf8"));
    return typeof data.hash === "string" ? data.hash : null;
  } catch {
    return null;
  }
}

/** Save the current devcontainer hash. */
function saveDevcontainerHash(workspace: string): void {
  const stateFile = join(workspace, ".devcontainer", STATE_FILE);
  const hash = computeDevcontainerHash(workspace);
  writeFileSync(stateFile, JSON.stringify({ hash, updatedAt: new Date().toISOString() }) + "\n");
}

/** Prompt the user with a yes/no question. Returns true if confirmed. */
function promptConfirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

/** Check if .devcontainer files changed and prompt for rebuild if needed. Returns true if clean was performed. */
async function checkDevcontainerChanged(workspace: string): Promise<boolean> {
  const savedHash = readSavedHash(workspace);
  if (savedHash === null) return false; // First run — no baseline yet.

  const currentHash = computeDevcontainerHash(workspace);
  if (currentHash === savedHash) return false;

  process.stderr.write(
    "[agent-sandbox] Detected changes in .devcontainer/ since last build.\n"
  );
  const confirmed = await promptConfirm(
    "[agent-sandbox] Clean and rebuild the container? [y/N]: "
  );
  if (confirmed) {
    cleanWorkspace(workspace);
    return true;
  }
  // User declined — update saved hash so we don't ask again for the same changes.
  saveDevcontainerHash(workspace);
  return false;
}

function runningContainerImage(workspace: string): string | null {
  const result = spawnSync(DOCKER, [
    "ps",
    "--filter", `label=devcontainer.local_folder=${workspace}`,
    "--format", "{{.Image}}",
  ], { encoding: "utf8" });
  return result.stdout.trim().split("\n").filter(Boolean)[0] ?? null;
}

function tagStableCacheImage(workspace: string): void {
  const image = runningContainerImage(workspace);
  if (!image) return;
  const tag = stableCacheTag(workspace);
  const result = spawnSync(DOCKER, ["tag", image, tag], { stdio: "inherit" });
  if (result.status === 0) {
    process.stderr.write(`[agent-sandbox] Tagged reusable cache image: ${tag}\n`);
  }
}

/** Start the devcontainer if it is not already running. */
function ensureContainer(workspace: string, options?: { noCache?: boolean }): void {
  if (containerIsRunning(workspace)) return;

  const releaseLock = acquireWorkspaceLock(workspace);
  try {
    if (containerIsRunning(workspace)) return;
    process.stderr.write(
      `[agent-sandbox] Container not running, starting devcontainer at ${workspace} …\n`
    );
    const args = ["up", "--workspace-folder", workspace];
    if (options?.noCache) {
      args.push("--no-cache");
    }
    execFileSync(getDevcontainer(), args, {
      stdio: "inherit",
    });
    tagStableCacheImage(workspace);
    saveDevcontainerHash(workspace);
  } finally {
    releaseLock();
  }
}

/** Show status of devcontainer(s) for the given workspace. */
function showStatus(workspace: string): void {
  const result = spawnSync(DOCKER, [
    "ps", "-a",
    "--filter", `label=devcontainer.local_folder=${workspace}`,
    "--format", "table {{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Image}}",
  ], { encoding: "utf8" });

  const output = result.stdout.trim();
  if (!output || output === "CONTAINER ID   NAMES   STATUS   IMAGE") {
    process.stdout.write(`[agent-sandbox] No container found for ${workspace}\n`);
    return;
  }
  process.stdout.write(output + "\n");
}


function stopContainers(workspace: string): void {
  const result = spawnSync(DOCKER, [
    "ps", "-q",
    "--filter", `label=devcontainer.local_folder=${workspace}`,
  ], { encoding: "utf8" });

  const ids = result.stdout.trim().split("\n").filter(Boolean);
  if (ids.length === 0) {
    process.stdout.write(`[agent-sandbox] No running container found for ${workspace}\n`);
    return;
  }
  process.stdout.write(`[agent-sandbox] Stopping container(s): ${ids.join(", ")} …\n`);
  spawnSync(DOCKER, ["stop", ...ids], { stdio: "inherit" });
  process.stdout.write("[agent-sandbox] Container(s) stopped.\n");
}


function cleanWorkspace(workspace: string): void {
  // 1. Find ALL containers (running + stopped) for this workspace.
  const containerResult = spawnSync(DOCKER, [
    "ps", "-a", "-q",
    "--filter", `label=devcontainer.local_folder=${workspace}`,
  ], { encoding: "utf8" });
  const containerIds = containerResult.stdout.trim().split("\n").filter(Boolean);

  // Collect image IDs before removing containers (so we can remove dangling images).
  const imageResult = spawnSync(DOCKER, [
    "ps", "-a",
    "--filter", `label=devcontainer.local_folder=${workspace}`,
    "--format", "{{.Image}}",
  ], { encoding: "utf8" });
  const containerImages = new Set(imageResult.stdout.trim().split("\n").filter(Boolean));

  if (containerIds.length > 0) {
    process.stdout.write(
      `[agent-sandbox] Removing ${containerIds.length} container(s): ${containerIds.join(", ")} …\n`
    );
    spawnSync(DOCKER, ["rm", "-f", ...containerIds], { stdio: "inherit" });
  } else {
    process.stdout.write("[agent-sandbox] No containers found for this workspace.\n");
  }

  // 2. Remove images that were used by this workspace's containers + our cache tag.
  //    Only removes images we can positively associate with this workspace via
  //    container labels or our own cache tag — never pattern-matches by name alone.
  const imagesToRemove: string[] = [...containerImages];

  const cacheTag = stableCacheTag(workspace);
  const cacheResult = spawnSync(DOCKER, [
    "images", "-q", cacheTag,
  ], { encoding: "utf8" });
  const cacheId = cacheResult.stdout.trim();
  if (cacheId) imagesToRemove.push(cacheId);

  const uniqueImages = [...new Set(imagesToRemove)];
  if (uniqueImages.length > 0) {
    process.stdout.write(
      `[agent-sandbox] Removing ${uniqueImages.length} image(s) …\n`
    );
    spawnSync(DOCKER, ["rmi", "-f", ...uniqueImages], { stdio: "inherit" });
  } else {
    process.stdout.write("[agent-sandbox] No related images found.\n");
  }

  process.stdout.write("[agent-sandbox] Clean complete.\n");
}


/** Remove containers, images, volumes, and Docker build cache for a full rebuild from scratch. */
function distcleanWorkspace(workspace: string): void {
  cleanWorkspace(workspace);

  // Remove volumes associated with this workspace's devcontainer.
  const volumeResult = spawnSync(DOCKER, [
    "volume", "ls", "-q",
    "--filter", `label=devcontainer.local_folder=${workspace}`,
  ], { encoding: "utf8" });
  const volumeIds = volumeResult.stdout.trim().split("\n").filter(Boolean);
  if (volumeIds.length > 0) {
    process.stdout.write(
      `[agent-sandbox] Removing ${volumeIds.length} volume(s) …\n`
    );
    spawnSync(DOCKER, ["volume", "rm", "-f", ...volumeIds], { stdio: "inherit" });
  }

  // Prune builder cache for devcontainer builds.
  process.stdout.write("[agent-sandbox] Pruning Docker build cache …\n");
  spawnSync(DOCKER, ["builder", "prune", "-f"], { stdio: "inherit" });

  // Remove state file so next build is treated as fresh.
  const stateFile = join(workspace, ".devcontainer", STATE_FILE);
  if (existsSync(stateFile)) {
    rmSync(stateFile);
    process.stdout.write("[agent-sandbox] Removed build state file.\n");
  }

  process.stdout.write("[agent-sandbox] Distclean complete.\n");
}


function execInContainer(workspace: string, command: string[]): number {
  // Source host-level llm.env (bind-mounted) before running the command,
  // so dynamic edits to ~/.agent-sandbox/llm.env are reflected each exec.
  const wrappedCommand = [
    "bash", "-c",
    `set -a; [ -f /run/host-llm.env ] && . /run/host-llm.env; set +a; exec "$@"`,
    "--", ...command,
  ];
  const result = spawnSync(
    getDevcontainer(),
    ["exec", "--workspace-folder", workspace, ...wrappedCommand],
    { stdio: "inherit" }
  );
  return result.status ?? 1;
}

function printUsage(): void {
  process.stderr.write(
    "usage: agent-sandbox <subcommand> [args…]\n" +
    "\n" +
    "Subcommands:\n" +
    "  init [-f|--force] [--install=<targets>]\n" +
    "                             Scaffold .devcontainer/ into the current directory.\n" +
    "                             Targets: playwright-cli, appium-cli\n" +
    "                             (comma-separated or repeat --install=...)\n" +
    "  status                     Show container name and status\n" +
    "  stop                       Stop the running devcontainer\n" +
    "  clean                      Remove containers and old images for this workspace\n" +
    "  distclean                  clean + remove volumes and Docker build cache\n" +
    "  rebuild                    distclean + rebuild the container from scratch\n" +
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
    "  agent-sandbox init --install=appium-cli\n" +
    "  agent-sandbox init --install=playwright-cli,appium-cli\n" +
    "  agent-sandbox init --install=playwright-cli --install=appium-cli\n" +
    "  agent-sandbox status\n" +
    "  agent-sandbox stop\n" +
    "  agent-sandbox distclean\n" +
    "  agent-sandbox rebuild\n" +
    "  agent-sandbox copilot --allow-all -p 'fix all failing tests'\n" +
    "  agent-sandbox claude --dangerously-skip-permissions -p 'run tests'\n" +
    "  agent-sandbox playwright-cli open https://example.com\n" +
    "  agent-sandbox appium-cli devices --platform android\n" +
    "  agent-sandbox -w /path/to/project copilot -p 'review code'\n"
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let workspaceOverride: string | null = null;
  const filtered: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--workspace" || args[i] === "-w") && i + 1 < args.length) {
      // resolve() converts relative paths to absolute paths.
      workspaceOverride = resolve(args[++i]);
    } else {
      filtered.push(args[i]);
    }
  }

  if (filtered.length === 0) {
    printUsage();
    process.exit(1);
  }

  // init subcommand: scaffold devcontainer config, no container needed
  if (filtered[0] === "init") {
    runInit(filtered.slice(1));
    return;
  }

  // status subcommand: show container name and status
  if (filtered[0] === "status") {
    try {
      const workspace = workspaceOverride ?? findWorkspace(process.cwd());
      showStatus(workspace);
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
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
      if (cleaned) return;
      cleaned = true;
      // Kill the watchdog — no longer needed on graceful exit.
      if (watchdogPid) {
        try { process.kill(watchdogPid); } catch { /* already gone */ }
      }
      try {
        stopContainers(workspace);
      } catch {
        // Best-effort cleanup; ignore errors.
      }
    };
    process.on("SIGINT", () => { cleanup(); process.exit(130); });
    process.on("SIGTERM", () => { cleanup(); process.exit(143); });

    const exitCode = execInContainer(workspace, filtered);
    cleanup();
    process.exit(exitCode);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

main();
