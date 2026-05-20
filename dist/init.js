"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runInit = runInit;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const TEMPLATES_DIR = (0, node_path_1.join)(__dirname, "..", "templates");
const SUPPORTED_TARGETS = ["appium-cli", "playwright-cli"];
// Layer application order: playwright first so its FROM wins, appium appended on top.
const LAYER_ORDER = ["playwright-cli", "appium-cli"];
const BASE_GITIGNORE_ADDITIONS = `
# LLM credentials (copy llm.env.example to llm.env)
.devcontainer/llm.env

# Staged host auth (temporary; auto-cleaned after container creation)
.devcontainer/.host-auth/

# agent-sandbox startup lock
.devcontainer/.agent-sandbox-up.lock/
`;
function parseInstallTargets(args) {
    const targets = new Set();
    const unsupported = [];
    for (const arg of args) {
        if (!arg.startsWith("--install="))
            continue;
        const value = arg.slice("--install=".length);
        if (value.trim() === "")
            continue;
        for (const raw of value.split(",")) {
            const token = raw.trim();
            if (token === "")
                continue;
            if (SUPPORTED_TARGETS.includes(token)) {
                targets.add(token);
            }
            else {
                unsupported.push(token);
            }
        }
    }
    if (unsupported.length > 0) {
        console.error(`[agent-sandbox] unsupported install target(s): ${unsupported.join(", ")}\n` +
            `Supported values: ${SUPPORTED_TARGETS.join(", ")} (comma-separated or repeated --install=...)`);
        process.exit(1);
    }
    return targets;
}
function selectedLayers(targets) {
    return LAYER_ORDER.filter((t) => targets.has(t));
}
function profileName(targets) {
    if (targets.size === 0)
        return "base";
    return Array.from(targets).sort().join("--");
}
function displayName(targets) {
    const parts = ["Copilot CLI", "Claude Code"];
    if (targets.has("playwright-cli"))
        parts.push("Playwright CLI");
    if (targets.has("appium-cli"))
        parts.push("Appium CLI");
    return `AI Agents (${parts.join(" + ")})`;
}
function buildPostCreateCommand(targets) {
    const parts = ["bash .devcontainer/setup-auth.sh"];
    if (targets.has("playwright-cli"))
        parts.push("(playwright-cli install --skills || true)");
    if (targets.has("appium-cli"))
        parts.push("(appium-cli install --skills || true)");
    return parts.join(" && ");
}
function generateDockerfile(targets) {
    const layers = selectedLayers(targets);
    const baseDockerfile = (0, node_fs_1.readFileSync)((0, node_path_1.join)(TEMPLATES_DIR, "base", ".devcontainer", "Dockerfile"), "utf8");
    // Replace the first FROM line if any layer provides a dockerfile.from.
    let dockerfile = baseDockerfile;
    for (const layer of layers) {
        const fromPath = (0, node_path_1.join)(TEMPLATES_DIR, "layers", layer, "dockerfile.from");
        if ((0, node_fs_1.existsSync)(fromPath)) {
            const newFrom = (0, node_fs_1.readFileSync)(fromPath, "utf8").trim();
            dockerfile = dockerfile.replace(/^FROM\s+.+$/m, newFrom);
            break;
        }
    }
    // Insert install marker after the first FROM line.
    const marker = `# agent-sandbox-installs: ${Array.from(targets).sort().join(",")}`;
    dockerfile = dockerfile.replace(/^(FROM\s+.+)$/m, `$1\n${marker}`);
    // Append each selected layer's dockerfile.append in layer order.
    const appended = [];
    for (const layer of layers) {
        const appendPath = (0, node_path_1.join)(TEMPLATES_DIR, "layers", layer, "dockerfile.append");
        if ((0, node_fs_1.existsSync)(appendPath)) {
            appended.push((0, node_fs_1.readFileSync)(appendPath, "utf8").trimEnd());
        }
    }
    if (appended.length === 0)
        return dockerfile.trimEnd() + "\n";
    return dockerfile.trimEnd() + "\n\n" + appended.join("\n\n") + "\n";
}
function dedupePush(target, items) {
    if (!items)
        return;
    for (const item of items) {
        if (!target.includes(item))
            target.push(item);
    }
}
function mergeDevcontainerJson(targets) {
    const base = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(TEMPLATES_DIR, "base", ".devcontainer", "devcontainer.json"), "utf8"));
    const merged = { ...base };
    merged.runArgs = base.runArgs ? [...base.runArgs] : [];
    merged.containerEnv = { ...(base.containerEnv ?? {}) };
    merged.mounts = base.mounts ? [...base.mounts] : [];
    for (const layer of selectedLayers(targets)) {
        const layerPath = (0, node_path_1.join)(TEMPLATES_DIR, "layers", layer, "devcontainer.layer.json");
        if (!(0, node_fs_1.existsSync)(layerPath))
            continue;
        const layerJson = JSON.parse((0, node_fs_1.readFileSync)(layerPath, "utf8"));
        dedupePush(merged.runArgs, layerJson.runArgs);
        dedupePush(merged.mounts, layerJson.mounts);
        if (layerJson.containerEnv) {
            merged.containerEnv = { ...merged.containerEnv, ...layerJson.containerEnv };
        }
        if (layerJson.remoteUser !== undefined) {
            merged.remoteUser = layerJson.remoteUser;
        }
    }
    if (merged.mounts && merged.mounts.length === 0)
        delete merged.mounts;
    if (merged.containerEnv && Object.keys(merged.containerEnv).length === 0) {
        delete merged.containerEnv;
    }
    merged.name = displayName(targets);
    merged.build = {
        dockerfile: "Dockerfile",
        cacheFrom: [`agent-sandbox-devcontainer:${profileName(targets)}`],
    };
    merged.postCreateCommand = buildPostCreateCommand(targets);
    return merged;
}
function copyLayerExtras(target, targets) {
    for (const layer of selectedLayers(targets)) {
        const extrasDir = (0, node_path_1.join)(TEMPLATES_DIR, "layers", layer, "extras");
        if (!(0, node_fs_1.existsSync)(extrasDir))
            continue;
        (0, node_fs_1.cpSync)(extrasDir, target, { recursive: true });
        console.log(`[agent-sandbox] Copied extras from layer: ${layer}`);
    }
}
function gatherGitignoreAdditions(targets) {
    let text = BASE_GITIGNORE_ADDITIONS;
    for (const layer of selectedLayers(targets)) {
        const gi = (0, node_path_1.join)(TEMPLATES_DIR, "layers", layer, "gitignore.txt");
        if ((0, node_fs_1.existsSync)(gi)) {
            text += "\n" + (0, node_fs_1.readFileSync)(gi, "utf8");
        }
    }
    return text;
}
function updateGitignore(target, additionsText) {
    let existing = "";
    if ((0, node_fs_1.existsSync)(target)) {
        existing = (0, node_fs_1.readFileSync)(target, "utf8");
    }
    const additions = additionsText.trim().split("\n").filter((line) => {
        const trimmed = line.trim();
        return trimmed === "" || trimmed.startsWith("#") || !existing.includes(trimmed);
    });
    if (additions.some((l) => l.trim() !== "" && !l.startsWith("#"))) {
        const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
        (0, node_fs_1.writeFileSync)(target, existing + separator + additions.join("\n") + "\n");
        console.log("[agent-sandbox] Updated .gitignore");
    }
}
function runInit(args) {
    const force = args.includes("--force") || args.includes("-f");
    const targets = parseInstallTargets(args);
    const target = (0, node_path_1.resolve)(process.cwd());
    const devcontainerDest = (0, node_path_1.join)(target, ".devcontainer");
    if ((0, node_fs_1.existsSync)(devcontainerDest) && !force) {
        console.error(`[agent-sandbox] .devcontainer/ already exists at ${target}\n` +
            "Use --force to overwrite.");
        process.exit(1);
    }
    if (force && (0, node_fs_1.existsSync)(devcontainerDest)) {
        (0, node_fs_1.rmSync)(devcontainerDest, { recursive: true, force: true });
    }
    // Start from base/.devcontainer (setup-auth.sh, llm.env.example).
    (0, node_fs_1.mkdirSync)(devcontainerDest, { recursive: true });
    (0, node_fs_1.cpSync)((0, node_path_1.join)(TEMPLATES_DIR, "base", ".devcontainer"), devcontainerDest, { recursive: true });
    // Overwrite generated Dockerfile and devcontainer.json with merged versions.
    (0, node_fs_1.writeFileSync)((0, node_path_1.join)(devcontainerDest, "Dockerfile"), generateDockerfile(targets));
    (0, node_fs_1.writeFileSync)((0, node_path_1.join)(devcontainerDest, "devcontainer.json"), JSON.stringify(mergeDevcontainerJson(targets), null, 2) + "\n");
    console.log("[agent-sandbox] Created .devcontainer/");
    // Copy any layer extras (e.g. .playwright/cli.config.json).
    copyLayerExtras(target, targets);
    // Create empty llm.env so devcontainer runArgs doesn't error.
    const llmEnvDest = (0, node_path_1.join)(devcontainerDest, "llm.env");
    if (!(0, node_fs_1.existsSync)(llmEnvDest)) {
        (0, node_fs_1.writeFileSync)(llmEnvDest, "# Edit this file to configure your LLM provider.\n# See llm.env.example for available options.\n");
        console.log("[agent-sandbox] Created .devcontainer/llm.env (empty)");
    }
    updateGitignore((0, node_path_1.join)(target, ".gitignore"), gatherGitignoreAdditions(targets));
    const profile = profileName(targets);
    const enabledList = targets.size === 0 ? "(none)" : Array.from(targets).sort().join(", ");
    const extraCommands = [];
    if (targets.has("playwright-cli")) {
        extraCommands.push("           agent-sandbox playwright-cli open https://example.com");
    }
    if (targets.has("appium-cli")) {
        extraCommands.push("           agent-sandbox appium-cli doctor");
        extraCommands.push("           agent-sandbox appium-cli devices --platform android");
    }
    console.log(`
✅ devcontainer configuration created at ${target}

Profile: ${profile}
Installs: ${enabledList}

Next steps:
  1. Edit .devcontainer/llm.env  (see llm.env.example for options)
  2. Run:  agent-sandbox copilot --version
           agent-sandbox claude --version
${extraCommands.join("\n")}
           (starts the container automatically on first run)
  3. Or open in VS Code with Dev Containers extension
`);
}
