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
const server = createServer((request, response) => {
  const auth = request.headers.authorization;
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
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    OPPER_EDITOR_HOME: home,
  };
  delete env.OPPER_API_KEY;
  delete env.OPPER_BASE_URL;

  const opperConfig = join(home, ".opper", "config.json");
  await mkdir(dirname(opperConfig), { recursive: true });
  await writeFile(opperConfig, JSON.stringify({
    version: 1, defaultKey: "default",
    keys: { default: { apiKey: "synthetic-opper-key", baseUrl: host } },
  }), { mode: 0o600 });

  const openCodeConfig = join(home, ".config", "opencode", "opencode.json");
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
  console.log("Real OpenCode loaded, rejected expired, and reloaded renewed CLI credentials with current models.");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
