// Local integration check: exercises the installed bridge and synthetic inference in real OpenCode.
// Run after `npm run build` with OpenCode on PATH. Uses only a synthetic key.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const run = promisify(execFile);
function runOpenCodeInference(args, options) {
  return new Promise((resolve, reject) => {
    const child = execFile("opencode", args, options, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
      } else {
        resolve({ stdout, stderr });
      }
    });
    // OpenCode reads piped stdin before starting a session. execFile otherwise
    // leaves that pipe open until the child exits, so both processes wait.
    child.stdin?.end();
  });
}
const home = await mkdtemp(join(tmpdir(), "opper-opencode-bridge-real-"));
let inferenceCalls = 0;
const requests = [];
const server = createServer((request, response) => {
  const auth = request.headers.authorization;
  requests.push({ path: request.url, auth, project: request.headers["x-opper-project"] });
  if (request.url === "/v3/compat/chat/completions" && request.method === "POST" && auth === "Bearer synthetic-opper-key") {
    inferenceCalls++;
    request.resume();
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const chunk = (delta, finish_reason = null) => JSON.stringify({
      id: "chatcmpl-synthetic", object: "chat.completion.chunk", created: 1,
      model: "anthropic/claude-sonnet-test", choices: [{ index: 0, delta, finish_reason }],
    });
    response.end(`data: ${chunk({ role: "assistant" })}\n\ndata: ${chunk({ content: "Bridge inference OK" })}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`);
    return;
  }
  if (request.url !== "/v3/compat/models" || !["Bearer synthetic-opper-key", "Bearer synthetic-opper-renewed", "Bearer synthetic-personal-env-key"].includes(auth)) {
    response.writeHead(403).end();
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ data: [{
    id: auth === "Bearer synthetic-opper-renewed" ? "anthropic/claude-sonnet-renewed" : "anthropic/claude-sonnet-test",
    context_length: 200000,
    pricing: { prompt: "0.000001", completion: "0.000002" },
    opper: { type: "llm", capabilities: ["tools"] },
  }] }));
});

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const host = `http://127.0.0.1:${address.port}`;
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, "xdg-config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    OPPER_HOME: join(home, ".opper"),
  };
  delete env.OPPER_API_KEY;
  delete env.OPPER_BASE_URL;
  delete env.OPPER_PROJECT_UUID;

  const opperConfig = join(home, ".opper", "config.json");
  await mkdir(dirname(opperConfig), { recursive: true });
  await writeFile(opperConfig, JSON.stringify({
    version: 1, defaultKey: "default",
    keys: { default: { apiKey: "synthetic-opper-key", baseUrl: host, orgId: 42, source: "device-flow", defaultProjectUuid: "22222222-2222-4222-8222-222222222222" } },
  }), { mode: 0o600 });

  delete env.OPPER_EDITOR_HOME;
  const openCodeConfig = join(env.XDG_CONFIG_HOME, "opencode", "opencode.json");
  await mkdir(dirname(openCodeConfig), { recursive: true });
  await writeFile(openCodeConfig, JSON.stringify({ "$schema": "https://opencode.ai/config.json", theme: "opencode" }));

  await run(process.execPath, [join(process.cwd(), "dist", "index.js"), "editors", "opencode", "--login-bridge"], {
    cwd: home, env, timeout: 30000,
  });
  async function debugConfig() {
    try {
      const output = await run("opencode", ["debug", "config"], { cwd: home, env, timeout: 30000, maxBuffer: 4_000_000 });
      return JSON.parse(output.stdout);
    } catch {
      throw new Error("OpenCode could not load the synthetic login bridge");
    }
  }
  const config = await debugConfig();
  assert.equal(config.provider?.opper?.options?.baseURL, `${host}/v3/compat`);
  assert.equal(config.provider?.opper?.options?.apiKey, "synthetic-opper-key");
  assert.deepEqual(config.provider?.opper?.whitelist, ["anthropic/claude-sonnet-test"]);
  assert.equal(JSON.parse(await readFile(openCodeConfig, "utf8")).theme, "opencode");

  try {
    const result = await runOpenCodeInference(["run", "--print-logs", "--log-level", "DEBUG", "--model", "opper/anthropic/claude-sonnet-test", "Say hi"], {
      cwd: home, env, timeout: 30000, maxBuffer: 4_000_000,
    });
    assert.match(result.stdout, /Bridge inference OK/);
  } catch (error) {
    throw new Error(`OpenCode did not complete synthetic inference through the Opper bridge (calls=${inferenceCalls}, code=${error.code}, signal=${error.signal}): ${error.stderr || error.stdout || error.message}`);
  }
  // OpenCode may also call the model to title the session. Every counted call
  // reached the mock compat endpoint with the synthetic bearer key.
  assert.ok(inferenceCalls >= 1);
  assert.ok(requests.every((request) => request.project === undefined), "resource default must not target org inference");

  const projectUuid = "11111111-1111-4111-8111-111111111111";
  await run(process.execPath, [join(process.cwd(), "dist", "index.js"), "--project-uuid", projectUuid, "editors", "opencode", "--login-bridge"], { cwd: home, env, timeout: 30000 });
  const beforeTarget = requests.length;
  const targeted = await debugConfig();
  assert.equal(targeted.provider?.opper?.options?.headers?.["X-Opper-Project"], projectUuid);
  const targetedAnswer = await runOpenCodeInference(["run", "--model", "opper/anthropic/claude-sonnet-test", "Say hi"], { cwd: home, env, timeout: 30000, maxBuffer: 4_000_000 });
  assert.match(targetedAnswer.stdout, /Bridge inference OK/);
  assert.ok(requests.slice(beforeTarget).some((request) => request.path === "/v3/compat/chat/completions"));
  assert.ok(requests.slice(beforeTarget).every((request) => request.project === projectUuid), "target must match across discovery and real inference");

  await writeFile(opperConfig, JSON.stringify({ version: 1, defaultKey: "default", keys: {
    default: { apiKey: "synthetic-opper-key", baseUrl: host, expiresAt: "2020-01-01T00:00:00Z" },
  } }), { mode: 0o600 });
  assert.equal((await debugConfig()).provider?.opper, undefined);

  await writeFile(opperConfig, JSON.stringify({ version: 1, defaultKey: "default", keys: {
    default: { apiKey: "synthetic-opper-renewed", baseUrl: host, expiresAt: "2030-01-01T00:00:00Z" },
  } }), { mode: 0o600 });
  const renewed = await debugConfig();
  assert.equal(renewed.provider?.opper?.options?.apiKey, "synthetic-opper-renewed");
  assert.deepEqual(renewed.provider?.opper?.whitelist, ["anthropic/claude-sonnet-renewed"]);

  await writeFile(opperConfig, JSON.stringify({ version: 1, defaultKey: "default", keys: {
    default: { apiKey: "synthetic-personal-key", baseUrl: host },
    finnova: { apiKey: "synthetic-opper-renewed", baseUrl: host },
  } }), { mode: 0o600 });
  await run(process.execPath, [join(process.cwd(), "dist", "index.js"), "--key", "finnova", "editors", "opencode", "--login-bridge"], {
    cwd: home, env, timeout: 30000,
  });
  env.OPPER_API_KEY = "synthetic-personal-env-key";
  env.OPPER_BASE_URL = host;
  const selected = await debugConfig();
  assert.equal(selected.provider?.opper?.options?.apiKey, "synthetic-personal-env-key");
  assert.equal(selected.provider?.opper?.options?.headers, undefined);

  env.OPPER_CLI_LAUNCH_OPENCODE = "1";
  env.OPPER_API_KEY = "synthetic-launch-key";
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: { opper: {
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: `${host}/v3/session/synthetic`, apiKey: "{env:OPPER_API_KEY}" },
    models: { "anthropic/claude-sonnet-test": { name: "Synthetic", limit: { context: 200000, output: 8192 } } },
  } } });
  const launched = await debugConfig();
  assert.equal(launched.provider?.opper?.options?.baseURL, `${host}/v3/session/synthetic`);
  assert.equal(launched.provider?.opper?.options?.apiKey, "synthetic-launch-key");
  console.log("Real OpenCode completed org and explicitly targeted synthetic inference, loaded/expired/renewed credentials, isolated an env key, and kept the launch session route.");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
