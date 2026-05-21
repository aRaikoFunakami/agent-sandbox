import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const TEMPLATES_DIR = join(__dirname, "..", "templates");

const SUPPORTED_TARGETS = ["appium-cli", "playwright-cli"] as const;
type InstallTarget = typeof SUPPORTED_TARGETS[number];

type AppiumServerMode = "host" | "container";

interface BuildOptions {
  appiumServer: AppiumServerMode;
}

interface LayerSelection {
  target: InstallTarget;
  layerDir: string;   // physical directory under templates/layers/
  profileKey: string; // identifier used in profile/cache tag
}

// Layer application order: playwright first so its FROM wins, appium appended on top.
const LAYER_ORDER: InstallTarget[] = ["playwright-cli", "appium-cli"];

const BASE_GITIGNORE_ADDITIONS = `
# LLM credentials (copy llm.env.example to llm.env)
.agent-sandbox/llm.env

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

function defaultAppiumServerMode(): AppiumServerMode {
  // Apple Silicon / macOS lacks linux-arm64 ChromeDriver builds, so default to
  // host-Appium for the WebView path. Linux hosts default to container mode.
  return process.platform === "darwin" ? "host" : "container";
}

function parseAppiumServerMode(args: string[]): AppiumServerMode {
  let mode: AppiumServerMode = defaultAppiumServerMode();
  for (const arg of args) {
    if (!arg.startsWith("--appium-server=")) continue;
    const value = arg.slice("--appium-server=".length).trim();
    if (value !== "host" && value !== "container") {
      console.error(
        `[agent-sandbox] unsupported --appium-server value: ${value}\n` +
        `Supported values: host, container`
      );
      process.exit(1);
    }
    mode = value;
  }
  return mode;
}

function layerDirFor(target: InstallTarget, opts: BuildOptions): string {
  if (target === "appium-cli" && opts.appiumServer === "host") {
    return "appium-cli-host";
  }
  return target;
}

function profileKeyFor(target: InstallTarget, opts: BuildOptions): string {
  // profileKey appears in the agent-sandbox-devcontainer cache tag and the
  // agent-sandbox-installs marker, so host vs container Appium produce
  // distinct images even when targets and Dockerfile FROM are the same.
  return layerDirFor(target, opts);
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

function selectedLayers(targets: Set<InstallTarget>, opts: BuildOptions): LayerSelection[] {
  return LAYER_ORDER.filter((t) => targets.has(t)).map((t) => ({
    target: t,
    layerDir: layerDirFor(t, opts),
    profileKey: profileKeyFor(t, opts),
  }));
}

function profileName(targets: Set<InstallTarget>, opts: BuildOptions): string {
  if (targets.size === 0) return "base";
  return selectedLayers(targets, opts)
    .map((l) => l.profileKey)
    .sort()
    .join("--");
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

function generateDockerfile(targets: Set<InstallTarget>, opts: BuildOptions): string {
  const layers = selectedLayers(targets, opts);
  const baseDockerfile = readFileSync(
    join(TEMPLATES_DIR, "base", ".devcontainer", "Dockerfile"),
    "utf8"
  );

  // Replace the first FROM line if any layer provides a dockerfile.from.
  let dockerfile = baseDockerfile;
  for (const layer of layers) {
    const fromPath = join(TEMPLATES_DIR, "layers", layer.layerDir, "dockerfile.from");
    if (existsSync(fromPath)) {
      const newFrom = readFileSync(fromPath, "utf8").trim();
      dockerfile = dockerfile.replace(/^FROM\s+.+$/m, newFrom);
      break;
    }
  }

  // Insert install marker after the first FROM line.
  const markerKeys = layers.map((l) => l.profileKey).sort().join(",");
  const marker = `# agent-sandbox-installs: ${markerKeys}`;
  dockerfile = dockerfile.replace(/^(FROM\s+.+)$/m, `$1\n${marker}`);

  // Append each selected layer's dockerfile.append in layer order.
  const appended: string[] = [];
  for (const layer of layers) {
    const appendPath = join(TEMPLATES_DIR, "layers", layer.layerDir, "dockerfile.append");
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

function mergeDevcontainerJson(targets: Set<InstallTarget>, opts: BuildOptions): DevcontainerJson {
  const base: DevcontainerJson = JSON.parse(
    readFileSync(join(TEMPLATES_DIR, "base", ".devcontainer", "devcontainer.json"), "utf8")
  );

  const merged: DevcontainerJson = { ...base };
  merged.runArgs = base.runArgs ? [...base.runArgs] : [];
  merged.containerEnv = { ...(base.containerEnv ?? {}) };
  merged.mounts = base.mounts ? [...base.mounts] : [];

  for (const layer of selectedLayers(targets, opts)) {
    const layerPath = join(TEMPLATES_DIR, "layers", layer.layerDir, "devcontainer.layer.json");
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
    cacheFrom: [`agent-sandbox-devcontainer:${profileName(targets, opts)}`],
  };
  merged.postCreateCommand = buildPostCreateCommand(targets);

  return merged;
}

function copyLayerExtras(target: string, targets: Set<InstallTarget>, opts: BuildOptions): void {
  for (const layer of selectedLayers(targets, opts)) {
    const extrasDir = join(TEMPLATES_DIR, "layers", layer.layerDir, "extras");
    if (!existsSync(extrasDir)) continue;
    cpSync(extrasDir, target, { recursive: true });
    console.log(`[agent-sandbox] Copied extras from layer: ${layer.layerDir}`);
  }
}

function gatherGitignoreAdditions(targets: Set<InstallTarget>, opts: BuildOptions): string {
  let text = BASE_GITIGNORE_ADDITIONS;
  for (const layer of selectedLayers(targets, opts)) {
    const gi = join(TEMPLATES_DIR, "layers", layer.layerDir, "gitignore.txt");
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

function createLlmEnvSet(dir: string, label: string): void {
  mkdirSync(dir, { recursive: true });

  const llmEnvExample = join(dir, "llm.env.example");
  cpSync(join(TEMPLATES_DIR, "base", ".devcontainer", "llm.env.example"), llmEnvExample);

  const llmEnvDest = join(dir, "llm.env");
  if (!existsSync(llmEnvDest)) {
    writeFileSync(
      llmEnvDest,
      "# Edit this file to configure your LLM provider.\n# See llm.env.example for available options.\n"
    );
    console.log(`[agent-sandbox] Created ${label}/llm.env (empty)`);
  }
}

export function runInit(args: string[]): void {
  const force = args.includes("--force") || args.includes("-f");
  const targets = parseInstallTargets(args);
  const opts: BuildOptions = { appiumServer: parseAppiumServerMode(args) };

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
  writeFileSync(join(devcontainerDest, "Dockerfile"), generateDockerfile(targets, opts));
  writeFileSync(
    join(devcontainerDest, "devcontainer.json"),
    JSON.stringify(mergeDevcontainerJson(targets, opts), null, 2) + "\n"
  );
  console.log("[agent-sandbox] Created .devcontainer/");

  // Copy any layer extras (e.g. .playwright/cli.config.json).
  copyLayerExtras(target, targets, opts);

  createLlmEnvSet(join(homedir(), ".agent-sandbox"), "~/.agent-sandbox");
  createLlmEnvSet(join(target, ".agent-sandbox"), ".agent-sandbox");

  updateGitignore(join(target, ".gitignore"), gatherGitignoreAdditions(targets, opts));

  const profile = profileName(targets, opts);
  const enabledList = targets.size === 0
    ? "(none)"
    : selectedLayers(targets, opts).map((l) => l.profileKey).sort().join(", ");
  const extraCommands: string[] = [];
  if (targets.has("playwright-cli")) {
    extraCommands.push("           agent-sandbox playwright-cli open https://example.com");
  }
  if (targets.has("appium-cli")) {
    extraCommands.push("           agent-sandbox appium-cli doctor");
    extraCommands.push("           agent-sandbox appium-cli devices --platform android");
    if (opts.appiumServer === "host") {
      extraCommands.push("           # host Appium required (run on the macOS host first):");
      extraCommands.push("           agent-sandbox appium host start");
    }
  }

  console.log(`
✅ devcontainer configuration created at ${target}

Profile: ${profile}
Installs: ${enabledList}
${targets.has("appium-cli") ? `Appium server mode: ${opts.appiumServer}\n` : ""}
Next steps:
  1. Edit ~/.agent-sandbox/llm.env for shared defaults.
     Edit .agent-sandbox/llm.env for project-specific overrides.
  2. Run:  agent-sandbox copilot --version
           agent-sandbox claude --version
${extraCommands.join("\n")}
           (starts the container automatically on first run)
  3. Or open in VS Code with Dev Containers extension
`);
}
