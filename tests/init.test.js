// Tests for `agent-sandbox init` host vs container Appium modes.
// Uses Node's built-in test runner; no third-party deps.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const CLI = join(__dirname, "..", "dist", "cli.js");

function runInit(cwd, extra) {
  return execFileSync(
    process.execPath,
    [CLI, "init", "--install=appium-cli", ...extra],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
}

function freshWorkspace() {
  return mkdtempSync(join(tmpdir(), "agent-sandbox-test-"));
}

test("init --appium-server=host produces host-mode devcontainer", () => {
  const ws = freshWorkspace();
  try {
    runInit(ws, ["--appium-server=host"]);
    const dc = JSON.parse(readFileSync(join(ws, ".devcontainer", "devcontainer.json"), "utf8"));
    assert.equal(dc.containerEnv?.APPIUM_SERVER_URL, "http://host.docker.internal:4723");
    assert.equal(dc.containerEnv?.APPIUM_REMOTE_ADB_HOST, undefined);
    assert.equal(dc.containerEnv?.APPIUM_REMOTE_ADB_PORT, undefined);
    assert.equal(dc.containerEnv?.ANDROID_HOME, undefined);
    assert.ok(dc.runArgs.includes("--add-host=host.docker.internal:host-gateway"));
    assert.deepEqual(dc.build.cacheFrom, ["agent-sandbox-devcontainer:appium-cli-host"]);

    const df = readFileSync(join(ws, ".devcontainer", "Dockerfile"), "utf8");
    assert.match(df, /agent-sandbox-installs:\s*appium-cli-host/);
    assert.doesNotMatch(df, /android-sdk-tools/i);
    assert.doesNotMatch(df, /appium driver install/i);
    assert.doesNotMatch(df, /npm install -g appium/i);
    assert.match(df, /appium-cli/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("init --appium-server=container preserves legacy behavior", () => {
  const ws = freshWorkspace();
  try {
    runInit(ws, ["--appium-server=container"]);
    const dc = JSON.parse(readFileSync(join(ws, ".devcontainer", "devcontainer.json"), "utf8"));
    assert.equal(dc.containerEnv?.APPIUM_SERVER_URL, undefined);
    assert.equal(dc.containerEnv?.APPIUM_REMOTE_ADB_HOST, "host.docker.internal");
    assert.equal(dc.containerEnv?.APPIUM_REMOTE_ADB_PORT, "5037");
    assert.equal(dc.containerEnv?.ADB_SERVER_SOCKET, "tcp:host.docker.internal:5037");
    assert.equal(dc.containerEnv?.ANDROID_HOME, "/opt/android-sdk");
    assert.deepEqual(dc.build.cacheFrom, ["agent-sandbox-devcontainer:appium-cli"]);

    const df = readFileSync(join(ws, ".devcontainer", "Dockerfile"), "utf8");
    assert.match(df, /agent-sandbox-installs:\s*appium-cli/);
    assert.match(df, /android-sdk/i);
    assert.match(df, /uiautomator2/i);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("init default on Darwin selects host mode", { skip: process.platform !== "darwin" }, () => {
  const ws = freshWorkspace();
  try {
    runInit(ws, []);
    const dc = JSON.parse(readFileSync(join(ws, ".devcontainer", "devcontainer.json"), "utf8"));
    assert.equal(dc.containerEnv?.APPIUM_SERVER_URL, "http://host.docker.internal:4723");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("appium host status (no server) reports running=false via JSON", () => {
  const home = mkdtempSync(join(tmpdir(), "as-home-"));
  try {
    let out;
    let exitCode = 0;
    try {
      out = execFileSync(
        process.execPath,
        [CLI, "appium", "host", "status", "--json", "--port=14723"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: home } }
      );
    } catch (err) {
      out = err.stdout?.toString() ?? "";
      exitCode = err.status ?? 1;
    }
    const parsed = JSON.parse(out);
    assert.equal(parsed.running, false);
    assert.equal(parsed.ownership, "none");
    assert.equal(parsed.port, 14723);
    assert.equal(exitCode, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("appium host stop with no state is a no-op", () => {
  const home = mkdtempSync(join(tmpdir(), "as-home-"));
  try {
    const out = execFileSync(
      process.execPath,
      [CLI, "appium", "host", "stop"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: home } }
    );
    assert.match(out, /No self-owned host Appium server to stop/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
