"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.which = which;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_child_process_1 = require("node:child_process");
/**
 * Resolve a binary name to its absolute path by scanning PATH.
 * - For "devcontainer": auto-installs via npm if not found.
 * - For other binaries: exits with a helpful error if not found.
 *
 * Resolving at startup ensures PATH-hijacking after process launch has no effect.
 */
function which(name) {
    const found = scanPath(name);
    if (found)
        return found;
    if (name === "devcontainer") {
        return installDevcontainerCli();
    }
    if (name === "docker") {
        process.stderr.write("error: 'docker' not found in PATH.\n" +
            "Please install Docker Desktop: https://www.docker.com/products/docker-desktop/\n");
        process.exit(1);
    }
    process.stderr.write(`error: '${name}' not found in PATH. Please install it.\n`);
    process.exit(1);
}
function scanPath(name) {
    const pathEnv = process.env.PATH ?? "";
    for (const dir of pathEnv.split(":")) {
        const fullPath = (0, node_path_1.join)(dir, name);
        if ((0, node_fs_1.existsSync)(fullPath)) {
            try {
                const stat = (0, node_fs_1.statSync)(fullPath);
                if (stat.isFile())
                    return fullPath;
            }
            catch {
                // skip unreadable entries
            }
        }
    }
    return null;
}
function installDevcontainerCli() {
    process.stderr.write("[agent-sandbox] 'devcontainer' not found. Installing @devcontainers/cli via npm...\n");
    try {
        (0, node_child_process_1.execFileSync)("npm", ["install", "-g", "@devcontainers/cli"], {
            stdio: "inherit",
        });
    }
    catch {
        process.stderr.write("error: Failed to install @devcontainers/cli.\n" +
            "Install manually: npm install -g @devcontainers/cli\n");
        process.exit(1);
    }
    const found = scanPath("devcontainer");
    if (!found) {
        process.stderr.write("error: @devcontainers/cli was installed but 'devcontainer' is still not found in PATH.\n" +
            "Try running: npm install -g @devcontainers/cli\n");
        process.exit(1);
    }
    process.stderr.write("[agent-sandbox] @devcontainers/cli installed successfully.\n");
    return found;
}
