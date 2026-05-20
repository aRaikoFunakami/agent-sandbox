import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const TEMPLATES_DIR = join(__dirname, "..", "templates");

const BASE_GITIGNORE_ADDITIONS = `
# LLM credentials (copy llm.env.example to llm.env)
.devcontainer/llm.env

# Staged host auth (temporary; auto-cleaned after container creation)
.devcontainer/.host-auth/

# agent-sandbox startup lock
.devcontainer/.agent-sandbox-up.lock/
`;

const PLAYWRIGHT_GITIGNORE_ADDITIONS = `
# playwright-cli artifacts
.playwright-cli
`;

/** Merge agent-sandbox entries into an existing or new .gitignore. */
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
  const installArg = args.find((arg) => arg.startsWith("--install="));
  const install = installArg ? installArg.slice("--install=".length) : "";
  const installPlaywrightCli = install === "playwright-cli";
  if (install && !installPlaywrightCli) {
    console.error(
      `[agent-sandbox] unsupported install target: ${install}\n` +
      "Supported values: --install=playwright-cli"
    );
    process.exit(1);
  }

  const target = resolve(process.cwd());
  const templateName = installPlaywrightCli ? "playwright-cli" : "base";
  const templateRoot = join(TEMPLATES_DIR, templateName);

  const devcontainerDest = join(target, ".devcontainer");
  const playwrightDest = join(target, ".playwright");

  if (existsSync(devcontainerDest) && !force) {
    console.error(
      `[agent-sandbox] .devcontainer/ already exists at ${target}\n` +
      "Use --force to overwrite."
    );
    process.exit(1);
  }

  // Copy template files
  if (force && existsSync(devcontainerDest)) {
    rmSync(devcontainerDest, { recursive: true, force: true });
  }
  mkdirSync(devcontainerDest, { recursive: true });
  cpSync(join(templateRoot, ".devcontainer"), devcontainerDest, { recursive: true });
  console.log("[agent-sandbox] Created .devcontainer/");

  if (installPlaywrightCli) {
    mkdirSync(playwrightDest, { recursive: true });
    cpSync(join(templateRoot, ".playwright"), playwrightDest, { recursive: true });
    console.log("[agent-sandbox] Created .playwright/");
  }

  // Create empty llm.env so devcontainer runArgs doesn't error
  const llmEnvDest = join(devcontainerDest, "llm.env");
  if (!existsSync(llmEnvDest)) {
    writeFileSync(llmEnvDest, "# Edit this file to configure your LLM provider.\n# See llm.env.example for available options.\n");
    console.log("[agent-sandbox] Created .devcontainer/llm.env (empty)");
  }

  updateGitignore(
    join(target, ".gitignore"),
    BASE_GITIGNORE_ADDITIONS + (installPlaywrightCli ? PLAYWRIGHT_GITIGNORE_ADDITIONS : "")
  );

  console.log(`
✅ devcontainer configuration created at ${target}

Profile: ${installPlaywrightCli ? "playwright-cli" : "base"}

Next steps:
  1. Edit .devcontainer/llm.env  (see llm.env.example for options)
  2. Run:  agent-sandbox copilot --version
           agent-sandbox claude --version
           (starts the container automatically on first run)
  3. Or open in VS Code with Dev Containers extension
`);
}
