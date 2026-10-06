import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Exercise the installed CLI and real npm-generated agent shims. The child
// programs and model catalog are fixtures; this makes no inference calls.
export async function runLaunchSmoke({ sandbox, env, cliPath, npmCliPath }) {
  assert.ok(npmCliPath && existsSync(npmCliPath), "Run this test with npm run test:smoke (npm's JS entry point is required).");
  const fixture = join(sandbox, "fixture package");
  const prefix = join(sandbox, "agent prefix");
  const cwd = join(sandbox, "project with spaces");
  const record = join(sandbox, "launch.json");
  const injectionMarker = join(sandbox, "injected.txt");
  const key = "synthetic-windows-launch-key";
  const project = "11111111-1111-4111-8111-111111111111";
  const model = "fixture-model";
  const windows = process.platform === "win32";
  const bin = windows ? prefix : join(prefix, "bin");
  mkdirSync(fixture, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  if (windows) {
    // A checkout must not supply the executable that receives the Opper key,
    // even when a PATH entry explicitly points at the working directory.
    for (const name of ["claude", "codex", "opencode", "pi", "npm", "npx"]) {
      writeFileSync(join(cwd, `${name}.cmd`), '@echo off\r\necho attacker > "%OPPER_INJECTION_SENTINEL%"\r\nexit /b 0\r\n');
    }
  }
  const programs = Object.fromEntries(["claude", "codex", "opencode", "pi"].map((name) => [name, `${name}.cjs`]));
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "opper-launch-fixture", version: "1.0.0", bin: programs }));
  for (const [name, script] of Object.entries(programs)) {
    writeFileSync(join(fixture, script), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.0.20'); process.exit(0); }
if (${JSON.stringify(name)} === 'opencode' && args[0] === 'api') {
  process.stdout.write(process.env.OPENCODE_CONFIG_CONTENT); process.exit(0);
}
const keys = ['ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_MODEL','ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY','OPPER_API_KEY','OPPER_BASE_URL','OPPER_PROJECT_UUID','OPENCODE_CONFIG_CONTENT'];
fs.writeFileSync(process.env.OPPER_LAUNCH_RECORD, JSON.stringify({ args, cwd: process.cwd(),
  env: Object.fromEntries(keys.map(k => [k, process.env[k]])) }));
process.exit(Number(process.env.OPPER_FIXTURE_EXIT || 0));
`, { mode: 0o755 });
  }
  function run(file, args, childEnv = env) {
    return new Promise((resolve, reject) => {
      const child = execFile(file, args, { cwd, env: childEnv, timeout: 45_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") return reject(error);
        resolve({ code: error?.code ?? 0, stdout, stderr });
      });
      child.stdin.end();
    });
  }
  // Exercise the same compiled installer used by `launch --install`, with a
  // local package and task-owned global prefix. This also checks Node's own
  // Windows npm launcher, whose format differs from ordinary npm bin shims.
  const installer = pathToFileURL(join(dirname(cliPath), "agents", "npm-install.js")).href;
  const installEnv = { ...env,
    NPM_CONFIG_PREFIX: prefix, NPM_CONFIG_CACHE: join(sandbox, "npm-cache"),
    NPM_CONFIG_IGNORE_SCRIPTS: "true", NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false",
    OPPER_INJECTION_SENTINEL: injectionMarker,
  };
  const installed = await run(process.execPath, ["--input-type=module", "-e",
    "const {npmInstallGlobal}=await import(process.argv[1]);await npmInstallGlobal(process.argv[2],'https://example.test');", installer, fixture], installEnv);
  assert.equal(installed.code, 0, installed.stderr);
  assert.ok(!existsSync(injectionMarker), "The installer executed a checkout's npm shim.");

  let denied = false;
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url, auth: req.headers.authorization, project: req.headers["x-opper-project"] });
    if (req.url === "/v3/compat/models") {
      if (denied || req.headers.authorization !== `Bearer ${key}` || req.headers["x-opper-project"] !== project) {
        res.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "Fixture catalog denied" }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: [{
          id: model, context_length: 128000,
          opper: { kind: "model", type: "llm", capabilities: ["tools"], max_output_tokens: 8192 },
        }] }));
      }
    } else if (req.url?.startsWith("/v2/analytics/usage")) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify([]));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const host = `http://127.0.0.1:${server.address().port}`;
    const launchEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== "PATH"));
    Object.assign(launchEnv, {
      // Only fixture agents, Node, and OS utilities may be discovered. A
      // developer's installed Claude must not mask the missing-agent case.
      PATH: [...(windows ? [cwd] : []), bin, dirname(process.execPath), ...(windows
        ? [join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32")]
        : ["/usr/bin", "/bin"])].join(delimiter),
      OPPER_API_KEY: key, OPPER_BASE_URL: host, OPPER_LAUNCH_RECORD: record,
      OPPER_ARG_EXPANSION: "must remain literal",
      OPPER_INJECTION_SENTINEL: injectionMarker,
    });
    const args = ["--fixture", "a prompt with spaces", 'a "quote"', "a&b|c>file", "%OPPER_ARG_EXPANSION%", "caret^", "åäö", "C:\\path with spaces\\", "first\nsecond", "first\r\nsecond",
      `first\r\nnode -e "require('fs').writeFileSync(process.env.OPPER_INJECTION_SENTINEL,'executed')"`, "long prompt ".repeat(1000), ""];
    const opencodeConfig = join(env.OPPER_EDITOR_HOME, ".config", "opencode", "opencode.json");
    const piConfig = join(env.HOME, ".pi", "agent", "models.json");
    const original = JSON.stringify({ theme: "fixture", provider: { unrelated: { value: "preserve" } } });
    mkdirSync(join(env.OPPER_EDITOR_HOME, ".config", "opencode"), { recursive: true });
    writeFileSync(opencodeConfig, original);
    const piOriginal = JSON.stringify({ providers: { unrelated: { value: "preserve" } } });
    mkdirSync(join(env.HOME, ".pi", "agent"), { recursive: true });
    writeFileSync(piConfig, piOriginal);
    async function launch(agent, childEnv = launchEnv, extraArgs = args) {
      rmSync(record, { force: true });
      return run(process.execPath, [cliPath, "--project-uuid", project, "launch", "--model", model, agent, ...extraArgs], childEnv);
    }
    for (const agent of Object.keys(programs)) {
      const result = await launch(agent);
      assert.equal(result.code, 0, `${agent}: ${result.stdout}\n${result.stderr}`);
      assert.ok(existsSync(record), `${agent} never reached the child process.`);
      const observed = JSON.parse(readFileSync(record, "utf8"));
      assert.deepEqual(observed.args.slice(-args.length), args, `${agent} did not preserve user arguments.`);
      assert.ok(!existsSync(injectionMarker), `${agent} interpreted a prompt as a shell command.`);
      assert.equal(observed.cwd, realpathSync(cwd));
      if (agent === "claude") {
        assert.ok(observed.env.ANTHROPIC_BASE_URL.startsWith(`${host}/v3/session/`));
        assert.equal(observed.env.ANTHROPIC_AUTH_TOKEN, key);
        assert.equal(observed.env.ANTHROPIC_MODEL, model);
        assert.equal(observed.env.ANTHROPIC_CUSTOM_HEADERS, `X-Opper-Project: ${project}`);
        assert.equal(observed.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
      } else {
        assert.equal(observed.env.OPPER_API_KEY, key);
      }
      if (agent === "codex") {
        const provider = observed.args[observed.args.indexOf("-c", 2) + 1];
        assert.ok(provider.includes(`${host}/v3/session/`));
        assert.ok(provider.includes(project));
      } else if (agent === "opencode") {
        assert.equal(observed.args[0], "--standalone");
        const options = JSON.parse(observed.env.OPENCODE_CONFIG_CONTENT).provider.opper.options;
        assert.ok(options.baseURL.startsWith(`${host}/v3/session/`));
        assert.equal(options.headers["X-Opper-Project"], project);
        assert.deepEqual(JSON.parse(readFileSync(opencodeConfig, "utf8")), JSON.parse(original));
      } else if (agent === "pi") {
        assert.deepEqual(observed.args.slice(0, 4), ["--provider", "opper", "--model", model]);
        assert.equal(observed.env.OPPER_PROJECT_UUID, project);
        assert.ok(observed.env.OPPER_BASE_URL.startsWith(`${host}/v3/session/`));
        assert.deepEqual(JSON.parse(readFileSync(piConfig, "utf8")), JSON.parse(piOriginal));
      }
      assert.equal((await launch(agent, { ...launchEnv, OPPER_FIXTURE_EXIT: "17" })).code, 17, `${agent} lost child exit code.`);
      console.log(`Packed CLI launch smoke passed (${agent}).`);
    }
    denied = true;
    for (const agent of ["opencode", "pi"]) {
      assert.notEqual((await launch(agent)).code, 0, `${agent} should reject a denied catalog.`);
      assert.ok(!existsSync(record), `${agent} launched despite a denied catalog.`);
    }
    assert.deepEqual(JSON.parse(readFileSync(opencodeConfig, "utf8")), JSON.parse(original));
    assert.deepEqual(JSON.parse(readFileSync(piConfig, "utf8")), JSON.parse(piOriginal));
    assert.ok(requests.some(req => req.path === "/v3/compat/models" && req.auth === `Bearer ${key}` && req.project === project));
    assert.ok(requests.every(req => req.path === "/v3/compat/models" || req.path.startsWith("/v2/analytics/usage")), "Unexpected network request.");
    for (const suffix of windows ? ["", ".cmd", ".ps1"] : [""]) rmSync(join(bin, `claude${suffix}`), { force: true });
    // Detection needs the OS's which/where, but must not fall back to a real
    // agent installed alongside Node in a developer's global npm prefix.
    const missingPath = [bin, ...(windows
      ? [join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32")]
      : ["/usr/bin", "/bin"])].join(delimiter);
    const missing = await launch("claude", { ...launchEnv, PATH: missingPath });
    assert.equal(missing.code, 3, missing.stderr);
    assert.match(missing.stderr, /not installed/);
    assert.ok(!existsSync(record));
    assert.ok(!existsSync(injectionMarker), "The missing-agent case executed a checkout's shim.");
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
