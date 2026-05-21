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

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { which } from "./which";

type Ownership = "self" | "external" | "none";

interface HostState {
  ownership: "self";
  pid: number;
  port: number;
  url: string;
  started_at: string;
  log_path: string;
}

const DEFAULT_PORT = 4723;

function hostStateDir(): string {
  return join(homedir(), ".agent-sandbox", "appium-host");
}

function hostStateFile(): string {
  return join(hostStateDir(), "state.json");
}

function hostLogFile(): string {
  return join(hostStateDir(), "appium.log");
}

function pidRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readState(): HostState | null {
  const file = hostStateFile();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as HostState;
  } catch {
    return null;
  }
}

function writeState(state: HostState): void {
  mkdirSync(hostStateDir(), { recursive: true });
  writeFileSync(hostStateFile(), JSON.stringify(state, null, 2) + "\n");
}

function clearState(): void {
  const file = hostStateFile();
  if (existsSync(file)) rmSync(file, { force: true });
}

/** Probe `<url>/status` with a short timeout. */
function probeAppium(url: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    try {
      const req = httpRequest(url.replace(/\/+$/, "") + "/status", { method: "GET", timeout: timeoutMs }, (res) => {
        // 200..499 is "responding"; appium /status returns 200 normally.
        finish((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 500);
        res.resume();
      });
      req.on("timeout", () => { req.destroy(); finish(false); });
      req.on("error", () => finish(false));
      req.end();
    } catch {
      finish(false);
    }
  });
}

function parsePortFlag(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && i + 1 < args.length) {
      const v = Number(args[i + 1]);
      if (Number.isInteger(v) && v > 0) return v;
    } else if (args[i].startsWith("--port=")) {
      const v = Number(args[i].slice("--port=".length));
      if (Number.isInteger(v) && v > 0) return v;
    }
  }
  return DEFAULT_PORT;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function appiumUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Verify host-side prerequisites for self-starting Appium. */
function precheckHost(): { ok: true; appium: string; adb: string } | { ok: false; message: string } {
  let appiumBin: string;
  try {
    appiumBin = which("appium");
  } catch {
    return {
      ok: false,
      message:
        "[agent-sandbox] `appium` is not on PATH on this host.\n" +
        "Install it with:  npm install -g appium\n" +
        "Then install the Android driver:  appium driver install uiautomator2\n" +
        "agent-sandbox does not install Appium on the host.",
    };
  }
  let adbBin: string;
  try {
    adbBin = which("adb");
  } catch {
    return {
      ok: false,
      message:
        "[agent-sandbox] `adb` is not on PATH on this host.\n" +
        "Install Android platform-tools (e.g. via `brew install --cask android-platform-tools`).",
    };
  }
  // Verify uiautomator2 driver is installed.
  try {
    const res = spawnSync(appiumBin, ["driver", "list", "--installed"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const combined = (res.stdout ?? "") + (res.stderr ?? "");
    if (!/uiautomator2/i.test(combined)) {
      return {
        ok: false,
        message:
          "[agent-sandbox] The Appium `uiautomator2` driver is not installed on this host.\n" +
          "Install it with:  appium driver install uiautomator2",
      };
    }
  } catch (err) {
    return {
      ok: false,
      message:
        `[agent-sandbox] Failed to query installed Appium drivers: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, appium: appiumBin, adb: adbBin };
}

async function startCommand(args: string[]): Promise<void> {
  const port = parsePortFlag(args);
  const url = appiumUrl(port);

  // 1. Reuse an already-running Appium on the port as external.
  if (await probeAppium(url)) {
    process.stdout.write(
      `[agent-sandbox] Reusing existing Appium server at ${url} (ownership=external).\n` +
      `Tip: agent-sandbox did not start this process and will not stop it.\n`
    );
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
  mkdirSync(hostStateDir(), { recursive: true });
  const logPath = hostLogFile();
  const logFd = openSync(logPath, "a");
  const appiumArgs = [
    "--address", "0.0.0.0",
    "--port", String(port),
    "--allow-insecure=uiautomator2:chromedriver_autodownload,uiautomator2:adb_shell",
  ];

  const child = spawn(pre.appium, appiumArgs, {
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
    if (!pidRunning(pid)) break;
    if (await probeAppium(url)) { ready = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!ready) {
    process.stderr.write(
      `[agent-sandbox] Host Appium did not become ready at ${url}. See ${logPath}\n`
    );
    if (pidRunning(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
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

  process.stdout.write(
    `[agent-sandbox] Started host Appium at ${url} (pid=${pid}, log=${logPath}).\n`
  );
}

async function stopCommand(_args: string[]): Promise<void> {
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
  } catch (err) {
    process.stderr.write(`[agent-sandbox] Failed to SIGTERM pid=${state.pid}: ${err}\n`);
    process.exit(1);
  }
  // Wait up to 10s for the process to exit.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!pidRunning(state.pid)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (pidRunning(state.pid)) {
    process.stderr.write(
      `[agent-sandbox] Host Appium pid=${state.pid} did not exit after SIGTERM.\n`
    );
    process.exit(1);
  }
  clearState();
  process.stdout.write(`[agent-sandbox] Stopped host Appium (pid=${state.pid}).\n`);
}

async function statusCommand(args: string[]): Promise<void> {
  const jsonOutput = hasFlag(args, "--json");
  const state = readState();
  const port = state?.port ?? parsePortFlag(args);
  const url = state?.url ?? appiumUrl(port);
  const running = await probeAppium(url);

  let ownership: Ownership = "none";
  let pid: number | null = null;
  if (running) {
    if (state && pidRunning(state.pid)) {
      ownership = "self";
      pid = state.pid;
    } else {
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
    if (!running) process.exit(1);
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
  if (!running) process.exit(1);
}

function logCommand(args: string[]): void {
  const follow = hasFlag(args, "--follow") || hasFlag(args, "-f");
  const logPath = readState()?.log_path ?? hostLogFile();
  if (!existsSync(logPath)) {
    process.stderr.write(`[agent-sandbox] No log file at ${logPath}.\n`);
    process.exit(1);
  }
  const tailArgs = follow ? ["-F", logPath] : ["-n", "200", logPath];
  const result = spawnSync("tail", tailArgs, { stdio: "inherit" });
  process.exit(result.status ?? 0);
}

/** Dispatch `agent-sandbox appium host <subcommand>`. */
export async function runAppiumHost(args: string[]): Promise<void> {
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
      process.stderr.write(
        "usage: agent-sandbox appium host <start|stop|status|log> [args]\n"
      );
      process.exit(1);
  }
}
