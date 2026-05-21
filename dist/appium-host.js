"use strict";
/**
 * Host-side Appium server lifecycle.
 *
 * For Apple Silicon macOS + arm64 Linux devcontainer Chrome/WebView workflows,
 * Appium must run on the macOS host (because Linux arm64 ChromeDriver does not
 * exist). This module manages the host process: probe / reuse an existing
 * server as "external", or self-start a new one and track its PID.
 *
 * Stop only ever terminates self-owned PIDs.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runAppiumHost = runAppiumHost;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_http_1 = require("node:http");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const which_1 = require("./which");
const DEFAULT_PORT = 4723;
function hostStateDir() {
    return (0, node_path_1.join)((0, node_os_1.homedir)(), ".agent-sandbox", "appium-host");
}
function hostStateFile() {
    return (0, node_path_1.join)(hostStateDir(), "state.json");
}
function hostLogFile() {
    return (0, node_path_1.join)(hostStateDir(), "appium.log");
}
function pidRunning(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function readState() {
    const file = hostStateFile();
    if (!(0, node_fs_1.existsSync)(file))
        return null;
    try {
        return JSON.parse((0, node_fs_1.readFileSync)(file, "utf8"));
    }
    catch {
        return null;
    }
}
function writeState(state) {
    (0, node_fs_1.mkdirSync)(hostStateDir(), { recursive: true });
    (0, node_fs_1.writeFileSync)(hostStateFile(), JSON.stringify(state, null, 2) + "\n");
}
function clearState() {
    const file = hostStateFile();
    if ((0, node_fs_1.existsSync)(file))
        (0, node_fs_1.rmSync)(file, { force: true });
}
/** Probe `<url>/status` with a short timeout. */
function probeAppium(url, timeoutMs = 1500) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (ok) => {
            if (done)
                return;
            done = true;
            resolve(ok);
        };
        try {
            const req = (0, node_http_1.request)(url.replace(/\/+$/, "") + "/status", { method: "GET", timeout: timeoutMs }, (res) => {
                // 200..499 is "responding"; appium /status returns 200 normally.
                finish((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 500);
                res.resume();
            });
            req.on("timeout", () => { req.destroy(); finish(false); });
            req.on("error", () => finish(false));
            req.end();
        }
        catch {
            finish(false);
        }
    });
}
function parsePortFlag(args) {
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--port" && i + 1 < args.length) {
            const v = Number(args[i + 1]);
            if (Number.isInteger(v) && v > 0)
                return v;
        }
        else if (args[i].startsWith("--port=")) {
            const v = Number(args[i].slice("--port=".length));
            if (Number.isInteger(v) && v > 0)
                return v;
        }
    }
    return DEFAULT_PORT;
}
function hasFlag(args, name) {
    return args.includes(name);
}
function appiumUrl(port) {
    return `http://127.0.0.1:${port}`;
}
/** Verify host-side prerequisites for self-starting Appium. */
function precheckHost() {
    let appiumBin;
    try {
        appiumBin = (0, which_1.which)("appium");
    }
    catch {
        return {
            ok: false,
            message: "[agent-sandbox] `appium` is not on PATH on this host.\n" +
                "Install it with:  npm install -g appium\n" +
                "Then install the Android driver:  appium driver install uiautomator2\n" +
                "agent-sandbox does not install Appium on the host.",
        };
    }
    let adbBin;
    try {
        adbBin = (0, which_1.which)("adb");
    }
    catch {
        return {
            ok: false,
            message: "[agent-sandbox] `adb` is not on PATH on this host.\n" +
                "Install Android platform-tools (e.g. via `brew install --cask android-platform-tools`).",
        };
    }
    // Verify uiautomator2 driver is installed.
    try {
        const res = (0, node_child_process_1.spawnSync)(appiumBin, ["driver", "list", "--installed"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        const combined = (res.stdout ?? "") + (res.stderr ?? "");
        if (!/uiautomator2/i.test(combined)) {
            return {
                ok: false,
                message: "[agent-sandbox] The Appium `uiautomator2` driver is not installed on this host.\n" +
                    "Install it with:  appium driver install uiautomator2",
            };
        }
    }
    catch (err) {
        return {
            ok: false,
            message: `[agent-sandbox] Failed to query installed Appium drivers: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
    return { ok: true, appium: appiumBin, adb: adbBin };
}
async function startCommand(args) {
    const port = parsePortFlag(args);
    const url = appiumUrl(port);
    // 1. Reuse an already-running Appium on the port as external.
    if (await probeAppium(url)) {
        process.stdout.write(`[agent-sandbox] Reusing existing Appium server at ${url} (ownership=external).\n` +
            `Tip: agent-sandbox did not start this process and will not stop it.\n`);
        return;
    }
    // 2. Check if we own a stale state pointing to a dead PID; clean it up.
    const stale = readState();
    if (stale && !pidRunning(stale.pid)) {
        clearState();
    }
    // 3. Strict precheck before self-starting.
    const pre = precheckHost();
    if (!pre.ok) {
        process.stderr.write(pre.message + "\n");
        process.exit(1);
    }
    // 4. Spawn detached Appium with chromedriver autodownload + adb_shell.
    (0, node_fs_1.mkdirSync)(hostStateDir(), { recursive: true });
    const logPath = hostLogFile();
    const logFd = (0, node_fs_1.openSync)(logPath, "a");
    const appiumArgs = [
        "--address", "0.0.0.0",
        "--port", String(port),
        "--allow-insecure=uiautomator2:chromedriver_autodownload,uiautomator2:adb_shell",
    ];
    const child = (0, node_child_process_1.spawn)(pre.appium, appiumArgs, {
        detached: true,
        stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    const pid = child.pid;
    if (!pid) {
        process.stderr.write("[agent-sandbox] Failed to spawn host Appium.\n");
        process.exit(1);
    }
    // 5. Wait up to ~30s for /status to respond.
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
        if (!pidRunning(pid))
            break;
        if (await probeAppium(url)) {
            ready = true;
            break;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    if (!ready) {
        process.stderr.write(`[agent-sandbox] Host Appium did not become ready at ${url}. See ${logPath}\n`);
        if (pidRunning(pid)) {
            try {
                process.kill(pid, "SIGTERM");
            }
            catch { /* ignore */ }
        }
        process.exit(1);
    }
    writeState({
        ownership: "self",
        pid,
        port,
        url,
        started_at: new Date().toISOString(),
        log_path: logPath,
    });
    process.stdout.write(`[agent-sandbox] Started host Appium at ${url} (pid=${pid}, log=${logPath}).\n`);
}
async function stopCommand(_args) {
    const state = readState();
    if (!state) {
        process.stdout.write("[agent-sandbox] No self-owned host Appium server to stop.\n");
        return;
    }
    if (!pidRunning(state.pid)) {
        clearState();
        process.stdout.write("[agent-sandbox] Self-owned host Appium server is already stopped.\n");
        return;
    }
    try {
        process.kill(state.pid, "SIGTERM");
    }
    catch (err) {
        process.stderr.write(`[agent-sandbox] Failed to SIGTERM pid=${state.pid}: ${err}\n`);
        process.exit(1);
    }
    // Wait up to 10s for the process to exit.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        if (!pidRunning(state.pid))
            break;
        await new Promise((r) => setTimeout(r, 200));
    }
    if (pidRunning(state.pid)) {
        process.stderr.write(`[agent-sandbox] Host Appium pid=${state.pid} did not exit after SIGTERM.\n`);
        process.exit(1);
    }
    clearState();
    process.stdout.write(`[agent-sandbox] Stopped host Appium (pid=${state.pid}).\n`);
}
async function statusCommand(args) {
    const jsonOutput = hasFlag(args, "--json");
    const state = readState();
    const port = state?.port ?? parsePortFlag(args);
    const url = state?.url ?? appiumUrl(port);
    const running = await probeAppium(url);
    let ownership = "none";
    let pid = null;
    if (running) {
        if (state && pidRunning(state.pid)) {
            ownership = "self";
            pid = state.pid;
        }
        else {
            ownership = "external";
        }
    }
    if (jsonOutput) {
        process.stdout.write(JSON.stringify({
            ok: running,
            running,
            ownership,
            port,
            url,
            pid,
            log_path: state?.log_path ?? null,
        }, null, 2) + "\n");
        if (!running)
            process.exit(1);
        return;
    }
    process.stdout.write(`running: ${running}\n`);
    process.stdout.write(`ownership: ${ownership}\n`);
    process.stdout.write(`port: ${port}\n`);
    process.stdout.write(`url: ${url}\n`);
    process.stdout.write(`pid: ${pid ?? "unknown"}\n`);
    if (state?.log_path) {
        process.stdout.write(`log: ${state.log_path}\n`);
    }
    if (!running)
        process.exit(1);
}
function logCommand(args) {
    const follow = hasFlag(args, "--follow") || hasFlag(args, "-f");
    const logPath = readState()?.log_path ?? hostLogFile();
    if (!(0, node_fs_1.existsSync)(logPath)) {
        process.stderr.write(`[agent-sandbox] No log file at ${logPath}.\n`);
        process.exit(1);
    }
    const tailArgs = follow ? ["-F", logPath] : ["-n", "200", logPath];
    const result = (0, node_child_process_1.spawnSync)("tail", tailArgs, { stdio: "inherit" });
    process.exit(result.status ?? 0);
}
/** Dispatch `agent-sandbox appium host <subcommand>`. */
async function runAppiumHost(args) {
    const sub = args[0];
    const rest = args.slice(1);
    switch (sub) {
        case "start":
            return startCommand(rest);
        case "stop":
            return stopCommand(rest);
        case "status":
            return statusCommand(rest);
        case "log":
            return logCommand(rest);
        default:
            process.stderr.write("usage: agent-sandbox appium host <start|stop|status|log> [args]\n");
            process.exit(1);
    }
}
