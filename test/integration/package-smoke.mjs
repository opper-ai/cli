import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
assert.ok(existsSync(join(repo, "dist/index.js")), "Run npm run build before the package smoke test.");
const npmCliPath = process.env.npm_execpath;
assert.ok(npmCliPath && isAbsolute(npmCliPath) && existsSync(npmCliPath),
  "Run this script with npm run test:smoke so npm's absolute JS entry point is available.");

// Spaces exercise the installed shims without using a developer's global prefix.
const root = mkdtempSync(join(tmpdir(), "opper package smoke "));
const prefix = join(root, "install prefix");
const home = join(root, "home");
const windows = process.platform === "win32";
const shells = windows ? ["powershell", "cmd"] : ["sh"];

// Do not inherit API keys, login state, NODE_OPTIONS, or npm authentication.
const inherited = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
]);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => inherited.has(key.toUpperCase())));
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  OPPER_HOME: join(home, ".opper"),
  OPPER_EDITOR_HOME: home,
  CODEX_HOME: join(home, ".codex"),
  HERMES_HOME: join(home, ".hermes"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_CACHE_HOME: join(home, ".cache"),
  TMPDIR: root,
  TMP: root,
  TEMP: root,
  NPM_CONFIG_USERCONFIG: join(root, "npmrc"),
  NPM_CONFIG_GLOBALCONFIG: join(root, "global-npmrc"),
  CI: "1",
  NO_COLOR: "1",
  NO_UPDATE_NOTIFIER: "1",
});
async function run(shell, command, args, { cwd = root, timeout = 30_000, expectedCode = 0 } = {}) {
  const childEnv = { ...env, SMOKE_COMMAND: command };
  args.forEach((arg, i) => { childEnv[`SMOKE_ARG_${i}`] = arg; });
  let executable;
  let shellArgs;
  if (shell === "powershell") {
    executable = "pwsh.exe";
    const invocation = ["& $env:SMOKE_COMMAND", ...args.map((_, i) => `$env:SMOKE_ARG_${i}`)].join(" ");
    shellArgs = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `${invocation}; exit $LASTEXITCODE`];
  } else if (shell === "cmd") {
    executable = env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
    const invocation = ['"%SMOKE_COMMAND%"', ...args.map((_, i) => `"%SMOKE_ARG_${i}%"`)].join(" ");
    shellArgs = ["/d", "/s", "/c", `"${invocation}"`];
  } else {
    executable = "/bin/sh";
    const invocation = ['exec "$SMOKE_COMMAND"', ...args.map((_, i) => `"$SMOKE_ARG_${i}"`)].join(" ");
    shellArgs = ["-c", invocation];
  }
  const child = spawn(executable, shellArgs, {
    cwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: !windows,
    windowsVerbatimArguments: shell === "cmd",
  });
  const result = await new Promise((resolve) => {
    const stdout = []; const stderr = []; let bytes = 0; let error; let terminating;
    const stopTree = async () => {
      if (!child.pid) return;
      if (windows) {
        // Killing only cmd/pwsh leaves its Node and discovery children holding the
        // sandbox open. Keep the parent alive until taskkill targets this exact tree.
        await new Promise((done) => {
          const killer = spawn(join(env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR ?? "C:\\Windows", "System32", "taskkill.exe"),
            ["/PID", String(child.pid), "/T", "/F"], {stdio: "ignore", windowsHide: true});
          const timer = setTimeout(() => {killer.kill("SIGKILL"); child.kill("SIGKILL"); done();}, 5_000);
          killer.once("error", () => {clearTimeout(timer); child.kill("SIGKILL"); done();});
          killer.once("close", (code) => {clearTimeout(timer); if (code !== 0) child.kill("SIGKILL"); done();});
        });
      } else {
        try {process.kill(-child.pid, "SIGKILL");}
        catch {child.kill("SIGKILL");}
      }
    };
    const fail = (cause) => {if (error) return; error = cause; terminating = stopTree();};
    const collect = (chunks, chunk) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) {fail(new Error("Command output exceeded 4 MiB.")); return;}
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.once("error", (cause) => {error = cause;});
    const timer = setTimeout(() => fail(new Error(`Command timed out after ${timeout} ms.`)), timeout);
    child.once("close", async (status, signal) => {
      clearTimeout(timer); await terminating;
      resolve({status, signal, error, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8")});
    });
  });
  if (result.error) throw new Error(`${shell}: ${command} ${args.join(" ")} failed: ${result.error.message}\n${result.stdout}\n${result.stderr}`, { cause: result.error });
  assert.equal(result.status, expectedCode,
    `${shell}: ${command} ${args.join(" ")} exited ${result.status} (signal ${result.signal})\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

let smokeFailure;
try {
  mkdirSync(home, { recursive: true });
  writeFileSync(env.NPM_CONFIG_USERCONFIG, "");
  writeFileSync(env.NPM_CONFIG_GLOBALCONFIG, "");
  const installerShell = windows ? "cmd" : "sh";
  // Bootstrap npm by absolute JS entry point. Resolving npm.cmd by name can
  // make its %~dp0 relative to the checkout instead of npm's installation.
  console.log("Package smoke: packing the built CLI.");
  const packed = JSON.parse(await run(installerShell, process.execPath,
    [npmCliPath, "pack", "--json", "--ignore-scripts", "--pack-destination", root], { cwd: repo, timeout: 60_000 }));
  assert.equal(packed.length, 1, "npm pack should produce one package.");
  const tarball = join(root, packed[0].filename);
  console.log("Package smoke: installing the tarball into an isolated prefix.");
  await run(installerShell, process.execPath, [npmCliPath, "install", "--global", "--prefix", prefix, "--cache", join(root, "npm-cache"),
    "--ignore-scripts", "--no-audit", "--no-fund", tarball], { timeout: 180_000 });

  for (const shell of shells) {
    const command = windows
      ? join(prefix, shell === "powershell" ? "opper.ps1" : "opper.cmd")
      : join(prefix, "bin", "opper");
    assert.ok(existsSync(command), `npm did not generate the ${shell} command shim.`);
    console.log(`Package smoke: ${shell} version and help.`);
    assert.equal((await run(shell, command, ["--version"])).trim(), pkg.version);
    assert.match(await run(shell, command, ["--help"]), /Usage: opper/);
    console.log(`Package smoke: ${shell} agent discovery.`);
    const agents = await run(shell, command, ["agents", "list"]);
    for (const name of ["claude", "codex", "opencode"]) {
      assert.match(agents, new RegExp(`^${name}\\s`, "m"), `Missing ${name} from the installed package's agent list.`);
    }
    await run(shell, command, ["--definitely-not-an-opper-option"], { expectedCode: 1 });
    console.log(`Packed package smoke passed (${shell}).`);
  }

  const { runLaunchSmoke } = await import("./launch-smoke.mjs");
  const cliPath = windows
    ? join(prefix, "node_modules", "@opperai", "cli", "dist", "index.js")
    : join(prefix, "lib", "node_modules", "@opperai", "cli", "dist", "index.js");
  await runLaunchSmoke({ sandbox: root, env, cliPath, npmCliPath });
} catch (cause) {
  smokeFailure = cause;
  console.error(`Package smoke failed before cleanup: ${cause instanceof Error ? cause.message : String(cause)}`);
} finally {
  try {rmSync(root, { recursive: true, force: true, maxRetries: windows ? 10 : 3, retryDelay: windows ? 250 : 100 });}
  catch (cause) {
    // A transient scanner lock must not replace the command/assertion that failed.
    console.error(`Package smoke cleanup failed; sandbox remains at ${root}: ${cause instanceof Error ? cause.message : String(cause)}`);
    if (!smokeFailure) throw cause;
  }
}
if (smokeFailure) throw smokeFailure;
