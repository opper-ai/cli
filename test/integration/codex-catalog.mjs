// npm run build && CODEX_CATALOG_INTEGRATION=1 node test/integration/codex-catalog.mjs
// Real Codex picker RPC + Responses SSE through the adapters. Fake credentials,
// isolated homes, loopback only. No normal desktop app is opened or configured.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { toCodexModelCatalog } from "../../dist/setup/codex-models.js";
import { gunzipSync } from "node:zlib";
const exec = promisify(execFile);
function run(command, args, options) {
  const promise = exec(command, args, { ...options, detached: true });
  promise.child.stdin.end();
  const deadline = setTimeout(() => { try { process.kill(-promise.child.pid, "SIGTERM"); } catch {} }, options.timeout ?? 30000);
  return promise.finally(() => clearTimeout(deadline));
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const binary = process.env.CODEX_CATALOG_BINARY || "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
if (process.env.CODEX_CATALOG_INTEGRATION !== "1") {
  console.log("SKIP Codex catalog runtime: opt in with CODEX_CATALOG_INTEGRATION=1 after npm run build.");
  process.exit(0);
}
await access(binary);
const home = await mkdtemp("/tmp/opper-codex-catalog-test-");
const pool = "catalog-pool", route = "dynamic/catalog-route", deployment = "vendor/catalog-model", extra = "vendor/catalog-hidden";
const key = "fake-codex-catalog-credential";
const entries = [
  { id: pool, context_length: 64000, opper: { kind: "pool", type: "llm", capabilities: ["tools"], members: [deployment] } },
  { id: deployment, context_length: 64000, opper: { kind: "model", type: "llm", capabilities: ["tools"] } },
  { id: extra, context_length: 64000, opper: { kind: "model", type: "llm", capabilities: ["tools"] } },
  { id: route, context_length: 64000, opper: { kind: "dynamic_route", capabilities: ["tools"], display_name: "Team Coding" } },
];
const requests = [];
let rejected = false;
let nativeSupported = false;
const server = createServer(async (request, response) => {
  requests.push({ method: request.method, path: request.url, auth: request.headers.authorization });
  if (request.headers.authorization !== `Bearer ${key}` || rejected) { response.writeHead(401).end(); return; }
  if (request.url.startsWith("/native-catalog")) {
    const standard = new URL(request.url, "http://fixture").searchParams.get("format") === "standard";
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(standard ? { data: entries } : toCodexModelCatalog(entries, pool, [], {})));
    return;
  }
  if (request.url.split("?")[0].endsWith("/models")) {
    response.setHeader("content-type", "application/json");
    const params = new URL(request.url, "http://fixture").searchParams;
    if (nativeSupported && params.get("format") === "codex") {
      const selected = params.get("selected_model");
      if (!entries.some(entry => entry.id === selected)) { response.statusCode = 400; response.end(JSON.stringify({error:"unavailable selection"})); return; }
      response.end(JSON.stringify(toCodexModelCatalog(entries, selected, [], {modelKinds: params.has("type") ? "pools,routes" : "all"}))); return;
    }
    response.end(JSON.stringify(request.url.startsWith("/v3/models") ? { models: [{ id: deployment }] } : { data: entries })); return;
  }
  if (request.method !== "POST" || !request.url.endsWith("/responses")) { response.writeHead(426).end(); return; }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  const body = JSON.parse((request.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString());
  requests.at(-1).model = body.model;
  const item = { id: "msg_fixture", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "CATALOG_RUNTIME_OK", annotations: [] }] };
  const completed = { id: "resp_fixture", object: "response", created_at: 1, status: "completed", model: body.model, output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end([
    { type: "response.created", response: { ...completed, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "CATALOG_RUNTIME_OK" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: completed },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const bin = join(home, "bin"), codexHome = join(home, "codex"), opperHome = join(home, "opper");
await Promise.all([mkdir(bin), mkdir(codexHome), mkdir(opperHome)]);
await symlink(binary, join(bin, "codex"));
const original = '# personal settings\nweb_search = "cached"\n[features]\nmulti_agent = false\n';
await writeFile(join(codexHome, "config.toml"), original);
const env = { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin`,
  HOME: home, CODEX_HOME: codexHome, OPPER_HOME: opperHome, TMPDIR: home, OTEL_SDK_DISABLED: "true",
  HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost" };
const options = { env, cwd: home, timeout: 30000, maxBuffer: 2_000_000 };
const routing = { apiBaseUrl: baseUrl, baseUrl: `${baseUrl}/v3/compat`, apiKey: key, model: pool, compatShape: "responses" };
const driver = join(home, "adapter.mjs");
await writeFile(driver, `import { codex } from ${JSON.stringify(pathToFileURL(join(repo, "dist/agents/codex.js")).href)};\nprocess.exitCode = await codex.spawn(JSON.parse(process.argv[2]), JSON.parse(process.argv[3]));\n`);

async function picker(command, args, environment = env) {
  const child = spawn(command, args, { cwd: home, env: environment, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let buffer = "", stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4000); });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`picker timeout: ${stderr}`)), 15000);
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", code => { clearTimeout(timer); reject(new Error(`picker exited ${code}: ${stderr}`)); });
      child.stdout.on("data", chunk => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let message; try { message = JSON.parse(line); } catch { continue; }
          if (message.id === 1) child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n" + JSON.stringify({ id: 2, method: "model/list", params: { includeHidden: false } }) + "\n");
          if (message.id === 2) { clearTimeout(timer); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result.data); }
        }
      });
      child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "catalog_fixture", version: "1" }, capabilities: { experimentalApi: true } } }) + "\n");
    });
  } finally {
    // End app-server cleanly so the adapter removes its invocation catalog.
    child.stdin.end();
    await new Promise(resolve => {
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGTERM"); } catch {} resolve(); }, 2000);
      child.on("close", () => { clearTimeout(timer); resolve(); });
    });
  }
}
const adapterPicker = routeOptions => picker(process.execPath, [driver, '["app-server"]', JSON.stringify({ ...routing, ...routeOptions })]);
const infer = async (model, native = false) => {
  const args = ["exec", "--skip-git-repo-check", "--json", "Say hello"];
  const output = native ? await run(binary, ["--model", model, ...args], options)
    : await run(process.execPath, [driver, JSON.stringify(args), JSON.stringify({ ...routing, model, modelOverride: model })], options);
  assert.ok(output.stdout.includes("CATALOG_RUNTIME_OK"), "real agent consumed fixture SSE response");
  assert.equal(requests.filter(row => row.method === "POST").at(-1).model, model);
  return output.stdout;
};
try {
  console.log((await run(binary, ["--version"], options)).stdout.trim());
  // Prove native app-server model/list is NOT HTTP gateway model discovery.
  const probeStart = requests.length;
  const nativeRows = await picker(binary, ["-c", 'model_provider="fixture"', "-c", `model_providers.fixture={name="Fixture",base_url="${baseUrl}/v3/compat",env_key="OPPER_API_KEY",wire_api="responses",requires_openai_auth=false}`, "app-server"], { ...env, OPPER_API_KEY: key });
  assert.ok(!nativeRows.some(row => row.model === route));
  assert.ok(!requests.slice(probeStart).some(row => row.method === "GET"), "native custom provider does not discover standard /models");
  console.log("native discovery fallback confirmed");
  assert.deepEqual((await adapterPicker({})).map(row => row.model), [pool, route]);
  console.log("fresh picker confirmed");
  const selected = await adapterPicker({ model: deployment });
  assert.deepEqual(selected.map(row => row.model), [deployment, route, pool]);
  assert.equal(selected[0].isDefault, true);
  assert.deepEqual((await adapterPicker({ modelKinds: "all" })).map(row => row.model), [pool, route, deployment, extra]);
  console.log("all/selected picker confirmed");
  const first = await infer(route);
  const threadID = first.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(row => row.type === "thread.started").thread_id;
  const resumed = await run(process.execPath, [driver, JSON.stringify(["exec", "--skip-git-repo-check", "--json", "resume", "--model", route, threadID, "Say hello"]), JSON.stringify(routing)], options);
  assert.ok(resumed.stdout.includes("CATALOG_RUNTIME_OK"));
  assert.equal(requests.filter(row => row.method === "POST").at(-1).model, route, "explicit native model survives resume after ephemeral catalog cleanup");
  await infer(deployment);
  assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), original);

  // A configured remote URL works natively on modern Codex and must retain
  // precedence over our generated fallback, including the adapter provider merge.
  const remoteConfig = `${original}\n[model_providers.opper-cli]\nmodel_catalog_url = "${baseUrl}/native-catalog"\n`;
  await writeFile(join(codexHome, "config.toml"), remoteConfig);
  const baselineProvider = `{ name = "Opper", base_url = "${baseUrl}/v3/compat", env_key = "OPPER_API_KEY", wire_api = "responses", requires_openai_auth = false, http_headers = {} }`;
  const baseline = await picker(binary, ["-c", 'model_provider="opper-cli"', "-c", `model_providers.opper-cli=${baselineProvider}`, "-c", 'web_search="disabled"', "--model", pool, "app-server"], { ...env, OPPER_API_KEY: key });
  assert.deepEqual(baseline.map(row => row.model), [pool, route], "original invocation flags preserve the native URL");
  let nativeStart = requests.length;
  assert.deepEqual((await adapterPicker({})).map(row => row.model), [pool, route]);
  const remoteRequests = requests.slice(nativeStart);
  assert.ok(remoteRequests.some(row => row.method === "GET" && row.path.startsWith("/native-catalog?client_version=")));
  assert.ok(!remoteRequests.some(row => row.path.startsWith("/v3/")), "adapter must not fetch or replace a configured remote catalog");
  nativeStart = requests.length;
  await infer(route);
  assert.equal(requests.filter(row => row.method === "POST").at(-1).model, route);
  assert.ok(!requests.slice(nativeStart).some(row => row.method === "GET" && row.path.startsWith("/v3/")));
  assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), remoteConfig);
  // The standard Opper ID response is not Codex metadata. The native request
  // happens, but the picker stays empty rather than accepting {data:[...]}.
  await writeFile(join(codexHome, "config.toml"), remoteConfig.replace('/native-catalog"', '/native-catalog?format=standard"'));
  nativeStart = requests.length;
  assert.deepEqual((await adapterPicker({})).map(row => row.model), []);
  assert.ok(requests.slice(nativeStart).some(row => row.path.includes("format=standard") && row.path.includes("client_version=")));
  await writeFile(join(codexHome, "config.toml"), original);
  console.log("native remote catalog baseline/current preservation and standard-vs-Codex metadata confirmed");

  nativeSupported = true;
  nativeStart = requests.length;
  assert.deepEqual((await adapterPicker({})).map(row => row.model), [pool, route]);
  assert.ok(requests.slice(nativeStart).some(row => row.path.includes("format=codex") && row.path.includes("client_version=")), "Codex itself refreshes the compatible native endpoint");
  assert.ok(!requests.slice(nativeStart).some(row => row.path.startsWith("/v3/models")), "native mode needs no secondary static metadata fetch");
  assert.deepEqual((await adapterPicker({model: deployment})).map(row => row.model), [deployment, route, pool]);
  assert.deepEqual((await adapterPicker({modelKinds: "all"})).map(row => row.model), [pool, route, deployment, extra]);
  nativeStart = requests.length;
  const disabledRows = await picker(process.execPath,[driver,JSON.stringify(["--disable","api_key_model_discovery","app-server"]),JSON.stringify(routing)]);
  assert.deepEqual(disabledRows.map(row=>row.model),[pool,route],"an explicit native-discovery opt-out uses the local fallback");
  assert.ok(!requests.slice(nativeStart).some(row=>row.path.includes("format=codex")),"passthrough feature opt-out must not probe native discovery");
  await infer(route);
  assert.equal(await readFile(join(codexHome,"config.toml"),"utf8"),original);
  console.log("native endpoint discovery and inference confirmed");

  // Optional older CLI demonstrates the compatibility gate uses the existing
  // explicit-model inference path, without requiring our newer catalog schema.
  const legacyBinary = process.env.CODEX_LEGACY_BINARY;
  if (legacyBinary) {
    const legacyBin = join(home, "legacy-bin");
    await mkdir(legacyBin);
    await symlink(legacyBinary, join(legacyBin, "codex"));
    const start = requests.length;
    const output = await run(process.execPath, [driver, JSON.stringify(["exec", "--skip-git-repo-check", "--json", "Say hello"]), JSON.stringify({ ...routing, model: deployment })],
      { ...options, env: { ...env, PATH: `${legacyBin}:${env.PATH}` } });
    assert.ok(output.stdout.includes("CATALOG_RUNTIME_OK"));
    assert.equal(requests.filter(row => row.method === "POST").at(-1).model, deployment);
    assert.ok(!requests.slice(start).some(row => row.method === "GET"), "older runtime does not require a generated catalog");
    console.log("legacy runtime explicit-model inference confirmed");
  }

  if (process.platform === "darwin") {
    const cli = join(repo, "dist/index.js");
    await writeFile(join(opperHome, "config.json"), JSON.stringify({ version: 1, defaultKey: "fixture", telemetry: { enabled: false }, keys: { fixture: { apiKey: key, baseUrl, source: "manual" } } }));
    const configure = (...extraArgs) => run(process.execPath, [cli, "--no-telemetry", "--key", "fixture", "agents", "configure", "codex-desktop", ...extraArgs], options);
    nativeSupported = false;
    await configure("--model", deployment, "--model-kinds", "all");
    const desktopCatalogPath = join(codexHome,"opper-desktop","catalog.json");
    await access(desktopCatalogPath); // The legacy server installed an owned file.
    nativeSupported = true;
    await configure();
    await assert.rejects(access(desktopCatalogPath),{code:"ENOENT"});
    const nativeConfig = await readFile(join(codexHome,"config.toml"),"utf8");
    assert.ok(nativeConfig.includes("model_catalog_url") && !nativeConfig.includes("model_catalog_json"), "Desktop uses the verified remote URL");
    assert.deepEqual((await picker(binary, ["app-server"])).map(row => row.model), [deployment, route, pool, extra]);
    await configure(); // upgrade retains selected provider and old full catalog
    assert.deepEqual((await picker(binary, ["app-server"])).map(row => row.model), [deployment, route, pool, extra]);
    await infer(deployment, true);
    const personalCatalog = '{"models":[{"slug":"personal/catalog"}]}';
    await writeFile(desktopCatalogPath,personalCatalog);
    const nativeStatePath=join(codexHome,"opper-desktop","state.json");
    const nativeStateBefore=await readFile(nativeStatePath,"utf8");
    const nativeConfigBefore=await readFile(join(codexHome,"config.toml"),"utf8");
    const unownedStart=requests.length;
    await assert.rejects(configure(),error=>/Unmanaged catalog/.test(error.stderr));
    await assert.rejects(run(process.execPath,[cli,"--no-telemetry","agents","remove","codex-desktop"],options),error=>/Unmanaged catalog/.test(error.stderr));
    assert.equal(await readFile(desktopCatalogPath,"utf8"),personalCatalog);
    assert.equal(await readFile(nativeStatePath,"utf8"),nativeStateBefore);
    assert.equal(await readFile(join(codexHome,"config.toml"),"utf8"),nativeConfigBefore);
    assert.equal(requests.length,unownedStart,"unexpected native catalog conflicts before discovery");
    await rm(desktopCatalogPath); // Remove only the disposable test's user file.
    const before = await readFile(join(codexHome, "config.toml"), "utf8");
    rejected = true;
    await assert.rejects(configure());
    assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), before);
    rejected = false;
    await run(process.execPath, [cli, "--no-telemetry", "agents", "remove", "codex-desktop"], options);
    assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), original);

    // An explicit home controls the native feature gate even while the ambient
    // CODEX_HOME supports it. Local catalogs still work in the opted-out home.
    const disabledHome = join(home, "explicit disabled home");
    await mkdir(disabledHome);
    const disabledOriginal = '[features]\napi_key_model_discovery = false\n';
    await writeFile(join(disabledHome,"config.toml"),disabledOriginal);
    const disabledStart = requests.length;
    await configure("--codex-home",disabledHome,"--model",pool);
    const disabledConfig = await readFile(join(disabledHome,"config.toml"),"utf8");
    assert.ok(disabledConfig.includes("model_catalog_json") && !disabledConfig.includes("model_catalog_url"));
    assert.ok(!requests.slice(disabledStart).some(row => row.path.includes("format=codex")),"disabled explicit home must not probe native discovery");
    assert.deepEqual((await picker(binary,["app-server"],{...env,CODEX_HOME:disabledHome})).map(row=>row.model),[pool,route]);
    await run(process.execPath,[cli,"--no-telemetry","agents","remove","codex-desktop","--codex-home",disabledHome],options);
    assert.equal(await readFile(join(disabledHome,"config.toml"),"utf8"),disabledOriginal);
  }
  assert.ok(requests.some(row => row.path === "/v3/compat/models"));
  assert.ok(requests.some(row => row.path === "/v3/models?limit=0"));
  console.log("PASS: legacy fallback and native endpoint discovery; real picker fresh/selected/all; route/provider SSE + explicit saved-session resume; desktop native refresh/failure/removal; configuration preserved.");
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
