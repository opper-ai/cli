// Run after npm run build with OpenCode 1.x installed. No real inference/key/config.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const cli = join(process.cwd(), "dist/index.js");
const home = await mkdtemp(join(tmpdir(), "opper-opencode-effort-"));
const calls = [];
let allowed = true;
let catalogStatus = 200;
const entry = (id, reasoning, kind = "model") => ({
  id, context_length: 128000, pricing: { prompt: "0.000001", completion: "0.000002" },
  opper: { kind, type: "llm", capabilities: ["tools", "reasoning"], max_output_tokens: 8192, ...(reasoning ? { reasoning } : {}) },
});
const entries = [
  entry("gpt-6.1-sol", { supported: ["low", "medium", "high", "xhigh", "max"], default: "medium" }, "pool"),
  entry("mixed-pool", { supported: ["high"], default: "high" }, "pool"),
  entry("missing-metadata"), entry("dynamic/unknown", undefined, "dynamic_route"),
];
const server = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = text ? JSON.parse(text) : undefined;
  calls.push({ path: req.url, auth: req.headers.authorization, project: req.headers["x-opper-project"], body });
  if (req.headers.authorization !== "Bearer synthetic-effort-key") return res.writeHead(401).end();
  if (req.url === "/v3/compat/models") {
    return res.writeHead(catalogStatus, { "Content-Type": "application/json" }).end(JSON.stringify({ data: allowed ? entries : [] }));
  }
  if (req.url?.endsWith("/chat/completions")) {
    const chunk = (delta, finish_reason = null) => JSON.stringify({ id: "chatcmpl-effort", object: "chat.completion.chunk", created: 1,
      model: body.model, choices: [{ index: 0, delta, finish_reason }] });
    return res.writeHead(200, { "Content-Type": "text/event-stream" }).end(
      `data: ${chunk({ role: "assistant" })}\n\ndata: ${chunk({ content: "Effort fixture OK" })}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`,
    );
  }
  res.writeHead(404).end();
});
function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd: home, env, timeout: 45000, maxBuffer: 8_000_000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    child.stdin?.end();
  });
}
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `http://127.0.0.1:${server.address().port}`;
  const inherited = Object.fromEntries(["PATH", "LANG", "LC_ALL", "TMPDIR"].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
  const env = { ...inherited, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), OPPER_HOME: join(home, ".opper"),
    OPPER_API_KEY: "synthetic-effort-key", OPPER_BASE_URL: host, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", npm_config_cache: join(home, "npm-cache"), BUN_INSTALL_CACHE_DIR: join(home, "bun-cache"), OPPER_NO_UPDATE_CHECK: "1" };
  await mkdir(env.OPPER_HOME, { recursive: true });
  await writeFile(join(env.OPPER_HOME, "config.json"), JSON.stringify({ version: 1, keys: { default: { apiKey: env.OPPER_API_KEY, baseUrl: host } } }));
  const configPath = join(env.XDG_CONFIG_HOME, "opencode/opencode.json");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ theme: "opencode", provider: { opper: { models: {
    "gpt-6.1-sol": { variants: { careful: { reasoningEffort: "high", temperature: 0 } } },
    revoked: { variants: { personal: { temperature: 0 } } },
  } } } }));
  const opper = (args) => run(process.execPath, [cli, ...args], env);
  const opencode = (args) => run("opencode", args, env);
  const version = (await opencode(["--version"])).stdout.trim();
  assert.match(version, /^1\./, "This fixture verifies OpenCode 1.x; adapt its model-list schema before using 2.x");
  await opper(["agents", "configure", "opencode"]);
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.provider.opper.whitelist, entries.map((entry) => entry.id));
  assert.equal(saved.provider.opper.models.revoked, undefined);
  const list = await opencode(["models", "opper", "--verbose", "--pure"]);
  assert.match(list.stdout, /"reasoningEffort": "max"/);
  const configBeforeLaunch = await readFile(configPath, "utf8");
  await opper(["launch", "--model", "gpt-6.1-sol", "opencode", "run", "--pure", "--variant", "max", "Say hi"]);
  const launchRequests = calls.filter((call) => call.body?.model === "gpt-6.1-sol" && /\/v3\/session\/sess_/.test(call.path));
  assert.ok(launchRequests.some((call) => call.body.reasoning_effort === "max"), "launch must forward selected max through session route");
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), JSON.parse(configBeforeLaunch), "launch must restore persistent settings");
  for (const [model, variant, expected] of [["gpt-6.1-sol", "xhigh", "xhigh"], ["gpt-6.1-sol", undefined, "medium"], ["gpt-6.1-sol", "careful", "high"], ["mixed-pool", "high", "high"], ["mixed-pool", "max", "high"], ["missing-metadata", undefined, undefined], ["dynamic/unknown", undefined, undefined]]) {
    const from = calls.length;
    await opencode(["run", "--pure", "--model", `opper/${model}`, ...(variant ? ["--variant", variant] : []), "Say hi"]);
    const requests = calls.slice(from).filter((call) => call.body?.model === model);
    assert.ok(requests.some((call) => call.body.reasoning_effort === expected), `request for ${model}/${variant ?? "default"}: expected ${expected}; got ${requests.map((call) => call.body.reasoning_effort)}`);
  }
  // Effective installed-client model listing must not resurrect unsupported inferred levels.
  const verboseModels = list.stdout.split(/^opper\//m).slice(1).map((part) => JSON.parse(part.slice(part.indexOf("\n"))));
  assert.deepEqual(Object.keys(verboseModels.find((model) => model.id === "gpt-6.1-sol").variants).sort(), ["careful", "high", "low", "max", "medium", "xhigh"].sort());
  assert.deepEqual(Object.keys(verboseModels.find((model) => model.id === "mixed-pool").variants), ["high"]);
  assert.deepEqual(verboseModels.find((model) => model.id === "missing-metadata").variants, {});
  assert.deepEqual(verboseModels.find((model) => model.id === "dynamic/unknown").variants, {});
  // Failure stops configure before mutating the existing file.
  const configBeforeFailure = await readFile(configPath, "utf8");
  catalogStatus = 503;
  await assert.rejects(opper(["agents", "configure", "opencode"]));
  assert.equal(await readFile(configPath, "utf8"), configBeforeFailure);
  catalogStatus = 200;
  // Exercise the installed managed login plugin, not just its exported unit functions.
  console.log("Installed OpenCode configure/launch/default/custom/pool/unsupported/missing/dynamic/503 checks passed.");
  // Preinstall OpenCode's declared plugin dependency with the isolated cache.
  // This keeps its background dependency installer out of the fixture path.
  await run("npm", ["install", "--prefix", dirname(configPath), "--ignore-scripts", "--no-audit", "--no-fund", `@opencode-ai/plugin@${version}`], env);
  await opper(["editors", "opencode", "--login-bridge"]);
  const bridgeConfig = JSON.parse((await opencode(["debug", "config", "--print-logs", "--log-level", "DEBUG"])).stdout);
  assert.equal(bridgeConfig.provider.opper.models["gpt-6.1-sol"].variants.max.reasoningEffort, "max");
  const bridgeFrom = calls.length;
  await opencode(["run", "--model", "opper/gpt-6.1-sol", "--variant", "max", "Say hi"]);
  assert.ok(calls.slice(bridgeFrom).some((call) => call.path === "/v3/compat/chat/completions" && call.body?.reasoning_effort === "max"));
  allowed = false;
  await opper(["agents", "configure", "opencode"]);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).provider.opper.whitelist, []);
  await assert.rejects(opencode(["models", "opper", "--pure"]), /Provider not found: opper/);
  console.log(JSON.stringify({ version, capturedRequests: calls.length,
    workflows: ["configure", "launch max/session/restoration", "xhigh", "default medium", "custom variant", "pool intersection", "unsupported pool max uses supported default", "missing metadata", "dynamic route", "503 no mutation", "installed login bridge max", "policy revoke all"], paidInference: false, cleanup: "fixture server and disposable HOME removed" }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
