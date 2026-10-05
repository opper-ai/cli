// Run after npm run build with OpenCode 1.x installed. No real inference/key/config.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const cli = process.env.OPPER_EFFORT_TEST_CLI || join(process.cwd(), "dist/index.js");
const home = await mkdtemp(join(tmpdir(), "opper-opencode-effort-"));
const calls = [];
const projectUuid = "11111111-1111-4111-8111-111111111111";
const staleOptions = { apiKey: "stale-key", baseURL: "http://127.0.0.1:1/stale", headers: {
  aUtHoRiZaTiOn: "Bearer stale-key", "x-OPPER-project": "stale-project", "X-Team": "fixture-team",
} };
let allowed = true;
let catalogStatus = 200;
const entry = (id, reasoning, kind = "model") => ({
  id, context_length: 128000, pricing: { prompt: "0.000001", completion: "0.000002" },
  opper: { kind, type: "llm", capabilities: ["tools", "reasoning"], max_output_tokens: 8192, ...(reasoning ? { reasoning } : {}) },
});
const entries = [
  entry("gpt-6.1-sol", { supported: ["low", "medium", "high", "xhigh", "max"], default: "medium" }, "pool"),
  entry("mixed-pool", { supported: ["high"], default: "high" }, "pool"),
  entry("missing-metadata"), entry("openai/gpt-5.4"), entry("fireworks/minimax-m3"), entry("dynamic/gpt-5", undefined, "dynamic_route"), entry("dynamic/unknown", undefined, "dynamic_route"),
];
const server = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = text ? JSON.parse(text) : undefined;
  calls.push({ path: req.url, auth: req.headers.authorization, project: req.headers["x-opper-project"], body });
  if (req.headers.authorization !== "Bearer synthetic-effort-key" || req.headers["x-opper-project"] !== projectUuid) return res.writeHead(401).end();
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
    OPPER_API_KEY: "synthetic-effort-key", OPPER_PROJECT_UUID: projectUuid, OPPER_BASE_URL: host, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", npm_config_cache: join(home, "npm-cache"), BUN_INSTALL_CACHE_DIR: join(home, "bun-cache"), OPPER_NO_UPDATE_CHECK: "1" };
  await mkdir(env.OPPER_HOME, { recursive: true });
  await writeFile(join(env.OPPER_HOME, "config.json"), JSON.stringify({ version: 1, keys: { default: { apiKey: env.OPPER_API_KEY, baseUrl: host } } }));
  const configPath = join(env.XDG_CONFIG_HOME, "opencode/opencode.json");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ theme: "opencode", provider: { opper: { models: {
    "gpt-6.1-sol": { options: { ...staleOptions, textVerbosity: "low" }, variants: { high: { disabled: true }, careful: { ...staleOptions, reasoningEffort: "high", temperature: 0 } } },
    "mixed-pool": { variants: { quick: { reasoningEffort: "max", temperature: 0 } } },
    revoked: { variants: { personal: { temperature: 0 } } },
  } } } }));
  const opper = (args) => run(process.execPath, [cli, "--project-uuid", projectUuid, ...args], env);
  const opencode = (args) => run("opencode", args, env);
  const version = (await opencode(["--version"])).stdout.trim();
  assert.match(version, /^1\./, "This fixture verifies OpenCode 1.x; adapt its model-list schema before using 2.x");
  await opper(["agents", "configure", "opencode"]);
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.provider.opper.whitelist, entries.map((entry) => entry.id));
  assert.equal(saved.provider.opper.models.revoked, undefined);
  assert.equal(saved.provider.opper.models["gpt-6.1-sol"].variants.high.disabled, true);
  assert.equal(saved.provider.opper.models["gpt-6.1-sol"].options.textVerbosity, "low");
  assert.ok(!JSON.stringify(saved).includes("stale"), "configure removes stale model and variant credentials/endpoints");
  assert.deepEqual(saved.provider.opper.models["gpt-6.1-sol"].options.headers, { "X-Team": "fixture-team" });
  assert.deepEqual(saved.provider.opper.models["gpt-6.1-sol"].variants.careful.headers, { "X-Team": "fixture-team" });
  assert.equal(saved.provider.opper.models["mixed-pool"].variants.quick.disabled, true);
  const list = await opencode(["models", "opper", "--verbose", "--pure"]);
  assert.match(list.stdout, /"reasoningEffort": "max"/);
  const configBeforeLaunch = await readFile(configPath, "utf8");
  await opper(["launch", "--model", "gpt-6.1-sol", "opencode", "run", "--pure", "--variant", "max", "Say hi"]);
  const launchRequests = calls.filter((call) => call.body?.model === "gpt-6.1-sol" && /\/v3\/session\/sess_/.test(call.path));
  assert.ok(launchRequests.some((call) => call.body.reasoning_effort === "max"), "launch must forward selected max through session route");
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), JSON.parse(configBeforeLaunch), "launch must restore persistent settings");
  for (const [model, variant, expected] of [["gpt-6.1-sol", "xhigh", "xhigh"], ["gpt-6.1-sol", undefined, "medium"], ["gpt-6.1-sol", "careful", "high"], ["mixed-pool", "high", "high"], ["mixed-pool", "max", "high"], ["missing-metadata", undefined, undefined], ["openai/gpt-5.4", undefined, "medium"], ["dynamic/gpt-5", undefined, "medium"], ["dynamic/unknown", undefined, undefined]]) {
    const from = calls.length;
    await opencode(["run", "--pure", "--model", `opper/${model}`, ...(variant ? ["--variant", variant] : []), "Say hi"]);
    const requests = calls.slice(from).filter((call) => call.body?.model === model && call.body?.tools?.length);
    assert.ok(requests.length > 0 && requests.every((call) => call.body.reasoning_effort === expected), `request for ${model}/${variant ?? "default"}: expected ${expected}; got ${requests.map((call) => call.body.reasoning_effort)}`);
  }
  // Effective installed-client model listing must not resurrect unsupported inferred levels.
  const verboseModels = list.stdout.split(/^opper\//m).slice(1).map((part) => JSON.parse(part.slice(part.indexOf("\n"))));
  assert.deepEqual(Object.keys(verboseModels.find((model) => model.id === "gpt-6.1-sol").variants).sort(), ["careful", "low", "max", "medium", "xhigh"].sort());
  assert.deepEqual(Object.keys(verboseModels.find((model) => model.id === "mixed-pool").variants), ["high"]);
  assert.deepEqual(verboseModels.find((model) => model.id === "fireworks/minimax-m3").variants, {}, "must suppress noncanonical inferred thinking");
  assert.deepEqual(verboseModels.find((model) => model.id === "missing-metadata").variants, {});
  assert.deepEqual(verboseModels.find((model) => model.id === "dynamic/unknown").variants, {});
  // OpenCode project layers may override generated user settings. Reject the
  // unsupported inherited choice after refresh, before any model request.
  const projectPath = join(home, "opencode.json");
  const project = JSON.stringify({ $schema: "https://opencode.ai/config.json", provider: { opper: { models: { "mixed-pool": {
    options: { reasoningEffort: "max" }, variants: { personal: { reasoningEffort: "max" } },
  } } } } });
  await writeFile(projectPath, project);
  const beforeConflict = await readFile(configPath, "utf8");
  const conflictFrom = calls.length;
  await assert.rejects(opper(["launch", "--model", "mixed-pool", "opencode", "run", "--pure", "--variant", "personal", "Say hi"]), /unsupported reasoning effort/);
  assert.equal(await readFile(projectPath, "utf8"), project);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), JSON.parse(beforeConflict));
  assert.ok(!calls.slice(conflictFrom).some((call) => call.path.endsWith("/chat/completions")));
  await rm(projectPath);
  // External model headers cannot override the selected key/project on launch.
  for (const [entry, error] of [
    [{ options: staleOptions }, /Authorization header/],
    [{ options: { apiKey: "stale-key" } }, /credential or endpoint overrides/],
    [{ options: { baseURL: "http://127.0.0.1:1/stale" } }, /credential or endpoint overrides/],
    [{ variants: { careful: { headers: { Authorization: "Bearer stale-key" } } } }, /Authorization header/],
  ]) {
    await writeFile(projectPath, JSON.stringify({ provider: { opper: { models: { "gpt-6.1-sol": entry } } } }));
    const conflictFrom = calls.length;
    await assert.rejects(opper(["launch", "--model", "gpt-6.1-sol", "opencode", "run", "--pure", "Say hi"]), error);
    assert.ok(!calls.slice(conflictFrom).some((call) => call.path.endsWith("/chat/completions")));
  }
  await rm(projectPath);
  // Inline settings are refreshed narrowly; no full catalog goes in the env.
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: { opper: { models: { "mixed-pool": {
    options: { reasoningEffort: "max", textVerbosity: "low" }, variants: { max: { reasoningEffort: "max" } },
  } } } } });
  const inlineFrom = calls.length;
  await opper(["launch", "--model", "mixed-pool", "opencode", "run", "--pure", "--variant", "max", "Say hi"]);
  assert.ok(calls.slice(inlineFrom).filter((call) => call.body?.model === "mixed-pool" && call.body?.tools?.length).every((call) => call.body.reasoning_effort === "high"));
  delete env.OPENCODE_CONFIG_CONTENT;
  // A custom effort survives a temporary policy restriction, but stays hidden
  // until the advertised effort returns. User-disabled canonical high stays off.
  entries[1].opper.reasoning.supported.push("max");
  await opper(["agents", "configure", "opencode"]);
  const restored = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(restored.provider.opper.models["mixed-pool"].variants.quick, { reasoningEffort: "max", temperature: 0 });
  assert.equal(restored.provider.opper.models["gpt-6.1-sol"].variants.high.disabled, true);
  const quickFrom = calls.length;
  await opencode(["run", "--pure", "--model", "opper/mixed-pool", "--variant", "quick", "Say hi"]);
  const quick = calls.slice(quickFrom).filter((call) => call.body?.model === "mixed-pool" && call.body?.tools?.length);
  assert.ok(quick.length && quick.every((call) => call.body.reasoning_effort === "max"));
  entries[1].opper.reasoning.supported.pop();
  await opper(["agents", "configure", "opencode"]);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).provider.opper.models["mixed-pool"].variants.quick.disabled, true);
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
  const beforeBridge = JSON.parse(await readFile(configPath, "utf8"));
  Object.assign(beforeBridge.provider.opper.models["gpt-6.1-sol"].options, staleOptions);
  Object.assign(beforeBridge.provider.opper.models["gpt-6.1-sol"].variants.careful, staleOptions);
  await writeFile(configPath, JSON.stringify(beforeBridge));
  await opper(["editors", "opencode", "--login-bridge"]);
  const bridgeConfig = JSON.parse((await opencode(["debug", "config", "--print-logs", "--log-level", "DEBUG"])).stdout);
  assert.equal(bridgeConfig.provider.opper.models["gpt-6.1-sol"].variants.max.reasoningEffort, "max");
  assert.ok(!JSON.stringify(bridgeConfig.provider.opper.models).includes("stale"), "installed bridge removes stale model/variant routing and auth");
  const bridgeFrom = calls.length;
  await opencode(["run", "--model", "opper/gpt-6.1-sol", "--variant", "max", "Say hi"]);
  assert.ok(calls.slice(bridgeFrom).some((call) => call.path === "/v3/compat/chat/completions" && call.body?.reasoning_effort === "max"));
  const carefulFrom = calls.length;
  await opencode(["run", "--model", "opper/gpt-6.1-sol", "--variant", "careful", "Say hi"]);
  assert.ok(calls.slice(carefulFrom).some((call) => call.body?.reasoning_effort === "high" && call.auth === "Bearer synthetic-effort-key" && call.project === projectUuid));
  // The plain bridge only refreshes memory. Explicit configure cleans saved
  // credentials before launch's deliberately strict preflight reads them.
  await opper(["agents", "configure", "opencode"]);
  // The installed bridge strips GPT-ID guesses when policy has no effort.
  for (const model of ["openai/gpt-5.4", "dynamic/gpt-5"]) {
    const from = calls.length;
    await opencode(["run", "--model", `opper/${model}`, "Say hi"]);
    const primary = calls.slice(from).filter((call) => call.body?.model === model && call.body?.tools?.length);
    assert.ok(primary.length && primary.every((call) => call.body.reasoning_effort === undefined));
  }
  const bridgeLaunchFrom = calls.length;
  await opper(["launch", "--model", "openai/gpt-5.4", "opencode", "run", "Say hi"]);
  const bridgeLaunch = calls.slice(bridgeLaunchFrom).filter((call) => call.body?.model === "openai/gpt-5.4" && call.body?.tools?.length);
  assert.ok(bridgeLaunch.length && bridgeLaunch.every((call) => /\/v3\/session\/sess_/.test(call.path) && call.body.reasoning_effort === undefined));
  allowed = false;
  await opper(["agents", "configure", "opencode"]);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).provider.opper.whitelist, []);
  await assert.rejects(opencode(["models", "opper", "--pure"]), /Provider not found: opper/);
  console.log(JSON.stringify({ version, capturedRequests: calls.length,
    workflows: ["configure", "launch max/session/restoration", "xhigh", "default medium", "custom variant", "pool intersection", "unsupported pool max uses supported default", "missing metadata", "dynamic route", "503 no mutation", "installed login bridge max", "policy revoke all", "project conflict/no inference/restoration", "inline stale effort refresh", "MiniMax inferred thinking disabled", "GPT5 plain/pure upstream default bound", "bridge GPT5/dynamic guesses stripped", "bridge launch scoped policy", "user-disabled canonical effort preserved", "compatible model options preserved", "custom effort revoke/restore/revoke", "configure strips stale model/variant credentials and endpoints", "external auth override rejected before inference", "installed bridge strips stale model/variant credentials and sends selected fake key/project"], paidInference: false, cleanup: "fixture server and disposable HOME removed" }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
