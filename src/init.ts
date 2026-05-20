import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const TEMPLATES_DIR = join(__dirname, "..", "templates");

const SUPPORTED_TARGETS = ["appium-cli", "playwright-cli"] as const;
type InstallTarget = typeof SUPPORTED_TARGETS[number];

// Layer application order: playwright first so its FROM wins, appium appended on top.
const LAYER_ORDER: InstallTarget[] = ["playwright-cli", "appium-cli"];

const BASE_GITIGNORE_ADDITIONS = `
# LLM credentials (copy llm.env.example to llm.env)
.devcontainer/llm.env

# Staged host auth (temporary; auto-cleaned after container creation)
.devcontainer/.host-auth/

# agent-sandbox startup lock
.devcontainer/.agent-sandbox-up.lock/
`;

interface DevcontainerJson {
  name?: string;
  build?: { dockerfile?: string; cacheFrom?: string[] };
  features?: Record<string, unknown>;
  initializeCommand?: string;
  runArgs?: string[];
  init?: boolean;
  remoteUser?: string;
  containerEnv?: Record<string, string>;
  mounts?: string[];
  postCreateCommand?: string;
  [key: string]: unknown;
}

interface LayerJson {
  runArgs?: string[];
  remoteUser?: string;
  containerEnv?: Record<string, string>;
  mounts?: string[];
}

function parseInstallTargets(args: string[]): Set<InstallTarget> {
  const targets = new Set<InstallTarget>();
  const unsupported: string[] = [];
  for (const arg of args) {
    if (!arg.startsWith("--install=")) continue;
    const value = arg.slice("--install=".length);
    if (value.trim() === "") continue;
    for (const raw of value.split(",")) {
      const token = raw.trim();
      if (token === "") continue;
      if ((SUPPORTED_TARGETS as readonly string[]).includes(token)) {
        targets.add(token as InstallTarget);
      } else {
        unsupported.push(token);
      }
    }
  }
  if (unsupported.length > 0) {
    console.error(
      `[agent-sandbox] unsupported install target(s): ${unsupported.join(", ")}\n` +
      `Supported values: ${SUPPORTED_TARGETS.join(", ")} (comma-separated or repeated --install=...)`
    );
    process.exit(1);
  }
  return targets;
}

function selectedLayers(targets: Set<InstallTarget>): InstallTarget[] {
  return LAYER_ORDER.filter((t) => targets.has(t));
}

function profileName(targets: Set<InstallTarget>): string {
  if (targets.size === 0) return "base";
  return Array.from(targets).sort().join("+");
}

function displayName(targets: Set<InstallTarget>): string {
  const parts = ["Copilot CLI", "Claude Code"];
  if (targets.has("playwright-cli")) parts.push("Playwright CLI");
  if (targets.has("appium-cli")) parts.push("Appium CLI");
  return `AI Agents (${parts.join(" + ")})`;
}

function buildPostCreateCommand(targets: Set<InstallTarget>): string {
  const parts = ["bash .devcontainer/setup-auth.sh"];
  if (targets.has("playwright-cli")) parts.push("(playwright-cli install --skills || true)");
  if (targets.has("appium-cli")) parts.push("(appium-cli install --skills || true)");
  return parts.join(" && ");
}

function generateDockerfile(targets: Set<InstallTarget>): string {
  const layers = selectedLayers(targets);
  const baseDockerfile = readFileSync(
    join(TEMPLATES_DIR, "base", ".devcontainer", "Dockerfile"),
    "utf8"
  );

  // Replace the first FROM line if any layer provides a dockerfile.from.
  let dockerfile = baseDockerfile;
  for (const layer of layers) {
    const fromPath = join(TEMPLATES_DIR, "layers", layer, "dockerfile.from");
    if (existsSync(fromPath)) {
      const newFrom = readFileSync(fromPath, "utf8").trim();
      dockerfile = dockerfile.replace(/^FROM\s+.+$/m, newFrom);
      break;
    }
  }

  // Insert install marker after the first FROM line.
  const marker = `# agent-sandbox-installs: ${Array.from(targets).sort().join(",")}`;
  dockerfile = dockerfile.replace(/^(FROM\s+.+)$/m, `$1\n${marker}`);

  // Append each selected layer's dockerfile.append in layer order.
  const appended: string[] = [];
  for (const layer of layers) {
    const appendPath = join(TEMPLATES_DIR, "layers", layer, "dockerfile.append");
    if (existsSync(appendPath)) {
      appended.push(readFileSync(appendPath, "utf8").trimEnd());
    }
  }

  if (appended.length === 0) return dockerfile.trimEnd() + "\n";
  return dockerfile.trimEnd() + "\n\n" + appended.join("\n\n") + "\n";
}

function dedupePush<T>(target: T[], items: T[] | undefined): void {
  if (!items) return;
  for (const item of items) {
    if (!target.includes(item)) target.push(item);
  }
}

function mergeDevcontainerJson(targets: Set<InstallTarget>): DevcontainerJson {
  const base: DevcontainerJson = JSON.parse(
    readFileSync(join(TEMPLATES_DIR, "base", ".devcontainer", "devcontainer.json"), "utf8")
  );

  const merged: DevcontainerJson = { ...base };
  merged.runArgs = base.runArgs ? [...base.runArgs] : [];
  merged.containerEnv = { ...(base.containerEnv ?? {}) };
  merged.mounts = base.mounts ? [...base.mounts] : [];

  for (const layer of selectedLayers(targets)) {
    const layerPath = join(TEMPLATES_DIR, "layers", layer, "devcontainer.layer.json");
    if (!existsSync(layerPath)) continue;
    const layerJson: LayerJson = JSON.parse(readFileSync(layerPath, "utf8"));
    dedupePush(merged.runArgs!, layerJson.runArgs);
    dedupePush(merged.mounts!, layerJson.mounts);
    if (layerJson.containerEnv) {
      merged.containerEnv = { ...merged.containerEnv, ...layerJson.containerEnv };
    }
    if (layerJson.remoteUser !== undefined) {
      merged.remoteUser = layerJson.remoteUser;
    }
  }

  if (merged.mounts && merged.mounts.length === 0) delete merged.mounts;
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

function copyLayerExtras(target: string, targets: Set<InstallTarget>): void {
  for (const layer of selectedLayers(targets)) {
    const extrasDir = join(TEMPLATES_DIR, "layers", layer, "extras");
    if (!existsSync(extrasDir)) continue;
    cpSync(extrasDir, target, { recursive: true });
    console.log(`[agent-sandbox] Copied extras from layer: ${layer}`);
  }
}

function gatherGitignoreAdditions(targets: Set<InstallTarget>): string {
  let text = BASE_GITIGNORE_ADDITIONS;
  for (const layer of selectedLayers(targets)) {
    const gi = join(TEMPLATES_DIR, "layers", layer, "gitignore.txt");
    if (existsSync(gi)) {
      text += "\n" + readFileSync(gi, "utf8");
    }
  }
  return text;
}

function updateGitignore(target: string, additionsText: string): void {
  let existing = "";
  if (existsSync(target)) {
    existing = readFileSync(target, "utf8");
  }
  const additions = additionsText.trim().split("\n").filter((line) => {
    const trimmed = line.trim();
    return trimmed === "" || trimmed.startsWith("#") || !existing.includes(trimmed);
  });
  if (additions.some((l) => l.trim() !== "" && !l.startsWith("#"))) {
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    writeFileSync(target, existing + separator + additions.join("\n") + "\n");
    console.log("[agent-sandbox] Updated .gitignore");
  }
}

export function runInit(args: string[]): void {
  const force = args.includes("--force") || args.includes("-f");
  const targets = parseInstallTargets(args);

  const target = resolve(process.cwd());
  const devcontainerDest = join(target, ".devcontainer");

  if (existsSync(devcontainerDest) && !force) {
    console.error(
      `[agent-sandbox] .devcontainer/ already exists at ${target}\n` +
      "Use --force to overwrite."
    );
    process.exit(1);
  }

  if (force && existsSync(devcontainerDest)) {
    rmSync(devcontainerDest, { recursive: true, force: true });
  }

  // Start from base/.devcontainer (setup-auth.sh, llm.env.example).
  mkdirSync(devcontainerDest, { recursive: true });
  cpSync(join(TEMPLATES_DIR, "base", ".devcontainer"), devcontainerDest, { recursive: true });

  // Overwrite generated Dockerfile and devcontainer.json with merged versions.
  writeFileSync(join(devcontainerDest, "Dockerfile"), generateDockerfile(targets));
  writeFileSync(
    join(devcontainerDest, "devcontainer.json"),
    JSON.stringify(mergeDevcontainerJson(targets), null, 2) + "\n"
  );
  console.log("[agent-sandbox] Created .devcontainer/");

  // Copy any layer extras (e.g. .playwright/cli.config.json).
  copyLayerExtras(target, targets);

  // Create empty llm.env so devcontainer runArgs doesn't error.
  const llmEnvDest = join(devcontainerDest, "llm.env");
  if (!existsSync(llmEnvDest)) {
    writeFileSync(
      llmEnvDest,
      "# Edit this file to configure your LLM provider.\n# See llm.env.example for available options.\n"
    );
    console.log("[agent-sandbox] Created .devcontainer/llm.env (empty)");
  }

  updateGitignore(join(target, ".gitignore"), gatherGitignoreAdditions(targets));

  const profile = profileName(targets);
  const enabledList = targets.size === 0 ? "(none)" : Array.from(targets).sort().join(", ");
  const extraCommands: string[] = [];
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
