// After npm run build: OPENCODE_BIN=/path/to/opencode node test/integration/catalog-display.mjs
// Real editor setup and OpenCode config loading; synthetic discovery only, no inference.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { effectiveOpenCodeConfig } from "../../dist/agents/opencode.js";

const run = promisify(execFile);
const binary = process.env.OPENCODE_BIN || "opencode";
const cli = join(process.cwd(), "dist", "index.js");
const directory = await mkdtemp(join(tmpdir(), "opper-catalog-display-"));
const routeID = "dynamic/team-regular";
let displayName = "Nitor Work Smart - Regular";
let withdrawn = false;
let failed = false;
const requests = [];
const server = createServer((request, response) => {
  requests.push({ path: request.url, method: request.method });
  if (request.method !== "GET" || request.url !== "/v3/compat/models" || request.headers.authorization !== "Bearer synthetic") {
    response.writeHead(403).end(); return;
  }
  if (failed) { response.writeHead(503).end(); return; }
  const data = [{ id: "vendor/regular", context_length: 128000,
    pricing: { prompt: "0.000001", completion: "0.000002" },
    opper: { kind: "model", display_name: "Work Smart v2", type: "llm", capabilities: ["tools"], max_output_tokens: 4096 } }];
  if (!withdrawn) data.push({ id: routeID, context_length: 128000,
    opper: { kind: "dynamic_route", display_name: displayName, pricing: { kind: "variable" },
      capabilities: ["tools"], max_output_tokens: 4096 } });
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ data }));
});

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => [
    "PATH", "TMPDIR", "LANG", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
  ].includes(key)));
  Object.assign(env, {
    OPPER_API_KEY: "synthetic", OPPER_BASE_URL: `http://127.0.0.1:${address.port}`,
    OPPER_EDITOR_HOME: directory, OPPER_HOME: join(directory, ".opper"),
    XDG_CONFIG_HOME: join(directory, ".config"), XDG_CACHE_HOME: join(directory, ".cache"),
    XDG_DATA_HOME: join(directory, ".local", "share"), XDG_STATE_HOME: join(directory, ".local", "state"),
    OPENCODE_TEST_HOME: directory, OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true", NPM_CONFIG_CACHE: join(directory, "npm-cache"),
  });
  const options = { cwd: directory, env, timeout: 45000, maxBuffer: 8_000_000 };
  const configPath = join(directory, ".config", "opencode", "opencode.json");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ provider: {
    other: { name: "Keep", npm: "@ai-sdk/openai-compatible", models: {} },
    opper: { name: "Opper", models: { [routeID]: { name: "Stale route", cost: { input: 0, output: 0 } } } },
  } }));
  const setup = () => run(process.execPath, [cli, "--no-telemetry", "editors", "opencode", "--overwrite"], options);
  const debug = async (pure = false) => {
    const args = major >= 2 ? ["api", "--standalone", "config.get", "--param", `directory=${directory}`]
      : ["debug", "config", "--print-logs", ...(pure ? ["--pure"] : [])];
    return effectiveOpenCodeConfig((await run(binary, args, options)).stdout);
  };
  const verify = async (expected, pure) => {
    const config = await debug(pure);
    const providers = config.provider ?? config.providers;
    assert.equal(providers.opper.models[routeID].name, expected);
    assert.ok(!Object.hasOwn(providers.opper.models[routeID], "cost"));
    assert.equal(providers.other.name, "Keep");
    const args = major >= 2 ? ["api", "--standalone", "model.list", "--print-logs"]
      : ["models", "opper", "--verbose", ...(pure ? ["--pure"] : []), "--print-logs"];
    const models = await run(binary, args, options);
    assert.ok(models.stdout.includes(routeID) && models.stdout.includes(expected));
    assert.ok(models.stderr.includes(configPath), "the isolated config must be loaded");
    if (major >= 2) {
      const rows = JSON.parse(models.stdout).data;
      const route = rows.find((model) => model.providerID === "opper" && model.id === routeID);
      assert.ok(route && route.enabled, "route stays selectable");
      assert.deepEqual(route.cost, [], "OpenCode 2 must retain unknown route pricing, not zero/free rates");
      const regular = rows.find((model) => model.providerID === "opper" && model.id === "vendor/regular");
      assert.equal(regular.cost[0].input, 1);
      assert.equal(regular.cost[0].output, 2);
    }
  };
  const version = (await run(binary, ["--version"], options)).stdout.trim();
  const major = Number(/\d+/.exec(version)?.[0]);
  console.log(`OpenCode ${version}`);
  await setup();
  await verify("Nitor Work Smart - Regular (route) · Variable pricing", true);
  displayName = "Nitor Work Smart - Better";
  await setup();
  await verify("Nitor Work Smart - Better (route) · Variable pricing", true);

  if (major >= 2) {
    withdrawn = true;
    await setup();
    assert.ok(!(await debug()).providers.opper.models[routeID]);
    failed = true;
    const before = await readFile(configPath, "utf8");
    await assert.rejects(setup());
    assert.equal(await readFile(configPath, "utf8"), before);
    console.log("OpenCode 2 generated editor refresh: stale zero rates removed, unknown cost [], route selectable, ordinary prices unchanged, rename/withdrawal/failure passed. No inference calls. The 1.x login plugin is not exercised on 2.x.");
  } else {
  const pluginPath = join(dirname(configPath), "plugins", "opper-login.js");
  // OpenCode waits for its config directory's SDK dependency install before
  // loading local plugins. Provision that public dependency in the disposable
  // directory so the integration does not depend on its background installer.
  await writeFile(join(directory, "npmrc"), "");
  await writeFile(join(directory, "npmrc-global"), "");
  const npmEnv = { ...env, NPM_CONFIG_USERCONFIG: join(directory, "npmrc"), NPM_CONFIG_GLOBALCONFIG: join(directory, "npmrc-global") };
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", `@opencode-ai/plugin@${version}`], {
    ...options, cwd: dirname(configPath), env: npmEnv,
  });
  await mkdir(dirname(pluginPath), { recursive: true });
  await writeFile(pluginPath, "// Managed by @opperai/cli.\nexport const OpperLoginPlugin = async () => ({});\n");
  await run(process.execPath, [cli, "--no-telemetry", "editors", "opencode", "--login-bridge"], options);
  assert.ok((await readFile(pluginPath, "utf8")).includes("Variable pricing"));
  displayName = "Nitor Work Smart - Premium";
  await verify("Nitor Work Smart - Premium (route) · Variable pricing", false);
  displayName = "   ";
  await verify("Team Regular (route) · Variable pricing", false);
  withdrawn = true;
  const withoutRoute = await debug();
  assert.ok(!withoutRoute.provider.opper.models[routeID]);
  assert.ok(!withoutRoute.provider.opper.whitelist.includes(routeID));
  failed = true;
  const failedPlugin = await debug();
  assert.ok(!failedPlugin.provider.opper, "unavailable catalog must not leave a stale provider");
  assert.equal(failedPlugin.provider.other.name, "Keep");
  const before = await readFile(configPath, "utf8");
  await assert.rejects(setup());
  assert.equal(await readFile(configPath, "utf8"), before, "failed editor refresh preserves config");
  console.log("Generated config and refreshed installed plugin: friendly/renamed/blank labels, withdrawal, failure and isolation passed. No inference calls.");
  }
  assert.ok(requests.length > 0 && requests.every((request) => request.method === "GET" && request.path === "/v3/compat/models"));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
