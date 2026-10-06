import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
assert.ok(existsSync(join(repo, "dist/index.js")), "Run npm run build before the package smoke test.");

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
function run(shell, command, args, { cwd = root, timeout = 30_000, expectedCode = 0 } = {}) {
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
  const result = spawnSync(executable, shellArgs, {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    windowsVerbatimArguments: shell === "cmd",
  });
  if (result.error) throw new Error(`${shell}: ${command} failed: ${result.error.message}`, { cause: result.error });
  assert.equal(result.status, expectedCode,
    `${shell}: ${command} ${args.join(" ")} exited ${result.status} (signal ${result.signal})\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

try {
  mkdirSync(home, { recursive: true });
  writeFileSync(env.NPM_CONFIG_USERCONFIG, "");
  writeFileSync(env.NPM_CONFIG_GLOBALCONFIG, "");
  const npm = windows ? "npm.cmd" : "npm";
  const installerShell = windows ? "cmd" : "sh";
  const packed = JSON.parse(run(installerShell, npm,
    ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { cwd: repo, timeout: 60_000 }));
  assert.equal(packed.length, 1, "npm pack should produce one package.");
  const tarball = join(root, packed[0].filename);
  run(installerShell, npm, ["install", "--global", "--prefix", prefix, "--cache", join(root, "npm-cache"),
    "--ignore-scripts", "--no-audit", "--no-fund", tarball], { timeout: 180_000 });

  for (const shell of shells) {
    const command = windows
      ? join(prefix, shell === "powershell" ? "opper.ps1" : "opper.cmd")
      : join(prefix, "bin", "opper");
    assert.ok(existsSync(command), `npm did not generate the ${shell} command shim.`);
    assert.equal(run(shell, command, ["--version"]).trim(), pkg.version);
    assert.match(run(shell, command, ["--help"]), /Usage: opper/);
    const agents = run(shell, command, ["agents", "list"]);
    for (const name of ["claude", "codex", "opencode"]) {
      assert.match(agents, new RegExp(`^${name}\\s`, "m"), `Missing ${name} from the installed package's agent list.`);
    }
    run(shell, command, ["--definitely-not-an-opper-option"], { expectedCode: 1 });
    console.log(`Packed package smoke passed (${shell}).`);
  }

  assert.ok(process.env.npm_execpath, "Run this script with npm run test:smoke so the npm CLI path is available.");
  const { runLaunchSmoke } = await import("./launch-smoke.mjs");
  const cliPath = windows
    ? join(prefix, "node_modules", "@opperai", "cli", "dist", "index.js")
    : join(prefix, "lib", "node_modules", "@opperai", "cli", "dist", "index.js");
  await runLaunchSmoke({ sandbox: root, env, cliPath, npmCliPath: process.env.npm_execpath });
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
