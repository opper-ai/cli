// Optional local integration check: exercises the installed bridge in real OpenCode.
// Run after `npm run build` with OpenCode on PATH. Uses only a synthetic key.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const run = promisify(execFile);
const home = await mkdtemp(join(tmpdir(), "opper-opencode-bridge-real-"));
let inferenceCalls = 0;
const server = createServer((request, response) => {
  const auth = request.headers.authorization;
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
  if (request.url !== "/v3/compat/models" || !["Bearer synthetic-opper-key", "Bearer synthetic-opper-renewed"].includes(auth)) {
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

  const opperConfig = join(home, ".opper", "config.json");
  await mkdir(dirname(opperConfig), { recursive: true });
  await writeFile(opperConfig, JSON.stringify({
    version: 1, defaultKey: "default",
    keys: { default: { apiKey: "synthetic-opper-key", baseUrl: host } },
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

  // OpenCode's `run` can stall during runtime init in some local environments,
  // even with an empty config. Keep the inference probe available for a host
  // where `opencode run` itself is known to start.
  if (process.env.OPPER_TEST_OPENCODE_INFERENCE === "1") {
    try {
      await run("opencode", ["run", "--print-logs", "--log-level", "DEBUG", "--model", "opper/anthropic/claude-sonnet-test", "Say hi"], {
        cwd: home, env, timeout: 30000, maxBuffer: 4_000_000,
      });
    } catch (error) {
      throw new Error(`OpenCode did not complete synthetic inference through the Opper bridge (calls=${inferenceCalls}, code=${error.code}, signal=${error.signal}): ${error.stderr || error.stdout || error.message}`);
    }
    assert.equal(inferenceCalls, 1);
  }

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
  const selected = await debugConfig();
  assert.equal(selected.provider?.opper?.options?.apiKey, "synthetic-opper-renewed");
  console.log(`Real OpenCode loaded, expired, renewed, and selected the CLI credential slot${inferenceCalls ? "; synthetic inference passed" : ""}.`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
