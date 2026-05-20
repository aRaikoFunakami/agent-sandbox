import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Resolve a binary name to its absolute path by scanning PATH.
 * - For "devcontainer": auto-installs via npm if not found.
 * - For other binaries: exits with a helpful error if not found.
 *
 * Resolving at startup ensures PATH-hijacking after process launch has no effect.
 */
export function which(name: string): string {
  const found = scanPath(name);
  if (found) return found;

  if (name === "devcontainer") {
    return installDevcontainerCli();
  }

  if (name === "docker") {
    process.stderr.write(
      "error: 'docker' not found in PATH.\n" +
      "Please install Docker Desktop: https://www.docker.com/products/docker-desktop/\n"
    );
    process.exit(1);
  }

  process.stderr.write(`error: '${name}' not found in PATH. Please install it.\n`);
  process.exit(1);
}

function scanPath(name: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    const fullPath = join(dir, name);
    if (existsSync(fullPath)) {
      try {
        const stat = statSync(fullPath);
        if (stat.isFile()) return fullPath;
      } catch {
        // skip unreadable entries
      }
    }
  }
  return null;
}

function installDevcontainerCli(): string {
  process.stderr.write(
    "[agent-sandbox] 'devcontainer' not found. Installing @devcontainers/cli via npm...\n"
  );
  try {
    execFileSync("npm", ["install", "-g", "@devcontainers/cli"], {
      stdio: "inherit",
    });
  } catch {
    process.stderr.write(
      "error: Failed to install @devcontainers/cli.\n" +
      "Install manually: npm install -g @devcontainers/cli\n"
    );
    process.exit(1);
  }
  const found = scanPath("devcontainer");
  if (!found) {
    process.stderr.write(
      "error: @devcontainers/cli was installed but 'devcontainer' is still not found in PATH.\n" +
      "Try running: npm install -g @devcontainers/cli\n"
    );
    process.exit(1);
  }
  process.stderr.write("[agent-sandbox] @devcontainers/cli installed successfully.\n");
  return found;
}
