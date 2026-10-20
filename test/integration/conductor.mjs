// After npm run build: CONDUCTOR_INTEGRATION=1 node test/integration/conductor.mjs
// Optional CONDUCTOR_RUNTIME / CONDUCTOR_CODEX_BINARY select installed binaries.
// CONDUCTOR_OPPER_BINARY=/path/to/bundle/bin/opper exercises a standalone bundle.
// Actual Conductor -> generated wrapper -> bundled Codex, with fake keys and a
// loopback Responses fixture only. Does not open or configure the normal app.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { toConductorModelCatalog } from "../../dist/setup/conductor-models.js";

const run = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repo, "dist", "index.js");
const cliBinary = process.env.CONDUCTOR_OPPER_BINARY;
const routeID = "dynamic/conductor-synthetic-route";
const poolID = "pool/conductor-synthetic-pool";
const additionalID = "synthetic/conductor-additional-model";
const unselectedID = "synthetic/conductor-unselected-model";
const projectUuid = "11111111-1111-4111-8111-111111111111";
const initialKey = "synthetic-conductor-key";
const rotatedKey = "synthetic-conductor-renewed-key";
const answer = "CONDUCTOR_SYNTHETIC_GATEWAY_OK";
const runtime = process.env.CONDUCTOR_RUNTIME || "/Applications/Conductor.app/Contents/Resources/bin/.internal/conductor-runtime";

async function executable(path) {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
}
async function installedCodex() {
  if (process.env.CONDUCTOR_CODEX_BINARY) return process.env.CONDUCTOR_CODEX_BINARY;
  const directory = join(homedir(), "Library", "Application Support", "com.conductor.app", "agent-binaries", "codex");
  let versions;
  try { versions = await readdir(directory); } catch { return undefined; }
  versions = versions.filter((version) => /^\d+\.\d+\.\d+$/.test(version)).sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const path = join(directory, version, "codex");
    if (await executable(path)) return path;
  }
}
if (process.env.CONDUCTOR_INTEGRATION !== "1") {
  console.log("SKIP Conductor integration: opt in with CONDUCTOR_INTEGRATION=1 after npm run build.");
  process.exit(0);
}
const codex = await installedCodex();
if (process.platform !== "darwin" || !codex || !await executable(codex) || !await executable(runtime)) {
  console.log("SKIP Conductor integration: installed macOS Conductor and bundled Codex are required (or set CONDUCTOR_RUNTIME and CONDUCTOR_CODEX_BINARY).");
  process.exit(0);
}
await access(cliBinary || cli);

// Keep Unix socket paths below macOS's length limit, independent of the host's
// often-long TMPDIR. Everything written by the real processes stays here.
const home = await mkdtemp("/tmp/opper-conductor-");
const temporary = await mkdtemp("/tmp/oc-");
const opperHome = join(home, ".opper");
const configPath = join(opperHome, "config.json");
const wrapper = join(opperHome, "conductor", "codex");
const conductorSettingsPath = join(home, ".conductor", "settings.toml");
const previousExecutable = join(home, "previous-codex");
const originalConductorSettings = '# Existing Conductor preferences\n' +
  "codex_provider = 'custom' # Previous authentication choice\n" +
  `codex_executable_path = ${JSON.stringify(previousExecutable)} # Previous executable\n` +
  'wrap_lines = true # Preserve this preference\nterminal_font_size = "14"\n' +
  '[git]\nbranch_prefix_custom = "keep-this-prefix"\n';
const normalCodex = join(home, ".codex");
const normalConfig = 'model = "synthetic-normal-codex"\nmodel_provider = "openai"\nweb_search = "cached"\n';
const normalAuth = '{"OPENAI_API_KEY":"synthetic-normal-auth"}\n';
const requests = [];
const children = new Set();
let activeKey = initialKey;
let expectedInferenceModel;
let fixtureError;
let nativeFormat = false;
let denied = false;
let nativeNewRoute = false;
const env = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin`,
  HOME: home, ZDOTDIR: home, SHELL: "/bin/zsh", TMPDIR: temporary,
  OPPER_HOME: opperHome, CODEX_HOME: normalCodex,
  XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
  XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state"),
  HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9",
  http_proxy: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9", all_proxy: "http://127.0.0.1:9",
  NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", OTEL_SDK_DISABLED: "true",
  CONDUCTOR_INTERNAL_BIN_DIR: dirname(runtime),
};

function responseEvents(model) {
  const item = { id: "msg_synthetic", type: "message", status: "completed", role: "assistant",
    content: [{ type: "output_text", text: answer, annotations: [] }] };
  const response = { id: "resp_synthetic", object: "response", created_at: 1, status: "completed", model,
    output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  return [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0,
      part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: answer },
    { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: answer },
    { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}
const server = createServer(async (request, response) => {
  try {
    const row = { path: request.url, method: request.method, auth: request.headers.authorization,
      project: request.headers["x-opper-project"] };
    requests.push(row);
    // Builtin Codex may probe a WebSocket URL before falling back to SSE. Such
    // a probe never represents successful inference and receives no model data.
    if (request.method === "GET" && request.url === "/v3/compat/responses") {
      response.writeHead(426).end(); return;
    }
    assert.equal(row.auth, `Bearer ${activeKey}`, "fixture received the current synthetic stored key");
    assert.equal(row.project, projectUuid, "discovery and inference retain the explicit project target");
    const url = new URL(request.url, "http://fixture");
    if (request.method === "GET" && url.pathname === "/v3/compat/models") {
      if (denied) {response.writeHead(401).end();return;}
      const entries = [
        { id: routeID, context_length: 128000, opper: { kind: "dynamic_route", display_name: "Conductor Synthetic Route",
          pricing: { kind: "variable" }, capabilities: ["tools"] } },
        { id: poolID, context_length: 64000, opper: { kind: "pool", type: "llm", display_name: "Conductor Synthetic Pool",
          members: [additionalID], capabilities: ["tools"] } },
        { id: additionalID, context_length: 32000, opper: { kind: "model", type: "llm", display_name: "Conductor Additional Model", capabilities: ["tools"] } },
        { id: unselectedID, context_length: 32000, opper: { kind: "model", type: "llm", capabilities: ["tools"] } },
        ...(nativeNewRoute ? [{id:"dynamic/new-native-route",context_length:64000,opper:{kind:"dynamic_route",capabilities:["tools"]}}] : []),
      ];
      const body = nativeFormat && url.searchParams.get("format") === "codex"
        ? toConductorModelCatalog(entries, url.searchParams.get("selected_model"), url.searchParams.has("type") ? "pools,routes" : "all")
        : {data:entries};
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body)); return;
    }
    if (request.method === "GET" && request.url === "/v3/models?limit=0") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ models: [{ id: additionalID }] })); return;
    }
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v3/compat/responses");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body = Buffer.concat(chunks);
    if (request.headers["content-encoding"] === "gzip") body = gunzipSync(body);
    else assert.ok(!request.headers["content-encoding"], "unrecognized request compression");
    const parsed = JSON.parse(body.toString("utf8"));
    row.model = parsed.model;
    assert.equal(parsed.model, expectedInferenceModel, "the model selected from Conductor keeps its exact gateway ID");
    assert.ok(!parsed.tools?.some((tool) => tool.type === "web_search" || tool.type === "web_search_preview"), "native web search remains disabled");
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    response.end(responseEvents(parsed.model));
  } catch (error) {
    fixtureError ??= error;
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Synthetic integration fixture rejected the request" } }));
  }
});

function bounded(promise, timeout, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout);
  })]).finally(() => clearTimeout(timer));
}
async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const closed = once(child, "close");
    child.kill("SIGTERM");
    try { await bounded(closed, 5000, "Conductor shutdown"); }
    catch {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await bounded(closed, 3000, "Conductor forced shutdown");
    }
  }
  // A descendant must not survive an early startup failure. The group belongs
  // only to this detached fixture process, never the user's app.
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
    if (error.code !== "ESRCH") {
      const groups=(await run("/bin/ps",["-axo","pid=,pgid=,stat=,comm="])).stdout.split("\n").filter(line=>Number(line.trim().split(/\s+/)[1])===child.pid);
      // macOS may report EPERM after the detached group has already exited.
      // Accept that only after checking no task-owned group member remains.
      if (error.code !== "EPERM" || groups.length) throw error;
    }
  }
  children.delete(child);
}

async function withSidecar(operation) {
  const child = spawn(runtime, ["sidecar"], { cwd: home, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stdout = "", stderr = "", socket;
  const events = [], waiters = new Set();
  const notify = () => { for (const waiter of waiters) waiter(); };
  child.stdout.on("data", (chunk) => { stdout += chunk; notify(); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-200000); });
  let failure;
  child.on("error", (error) => { failure = error; notify(); });
  child.on("close", () => { failure ??= new Error("Conductor sidecar closed before the operation completed"); notify(); });
  async function waitFor(predicate, label, timeout = 30000) {
    const check = () => {
      if (fixtureError) throw fixtureError;
      if (failure) throw failure;
      return predicate();
    };
    const found = check();
    if (found) return found;
    let onChange;
    return bounded(new Promise((resolve, reject) => {
      onChange = () => { try { const value = check(); if (value) resolve(value); } catch (error) { reject(error); } };
      waiters.add(onChange);
    }), timeout, label).finally(() => waiters.delete(onChange));
  }
  try {
    const socketPath = await waitFor(() => /^SOCKET_PATH=(.+)$/m.exec(stdout)?.[1], "Conductor socket startup", 10000);
    socket = createConnection(socketPath);
    await bounded(once(socket, "connect"), 5000, "Conductor socket connection");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          events.push(message);
          if (message.method && message.id !== undefined) {
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
          }
        } catch (error) { failure = error; }
      }
      notify();
    });
    socket.on("error", (error) => { failure = error; notify(); });
    let requestID = 0;
    async function rpc(method, params) {
      const id = ++requestID;
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      const message = await waitFor(() => events.find((event) => event.id === id), `Conductor ${method}`);
      assert.ok(!message.error, JSON.stringify(message.error));
      return message.result;
    }
    await rpc("setExternalLoggingDisabled", { disabled: true });
    return await operation({ rpc, events, waitFor });
  } catch (error) {
    throw new Error(`${error.message}\nConductor stderr (synthetic isolated process):\n${stderr.slice(-6000)}`, { cause: error });
  } finally {
    socket?.destroy();
    await stop(child);
  }
}
async function selectedExecutable() {
  // Read the operator-facing file independently of the adapter's settings
  // helper, then pass that selected value through Conductor's shipped RPC.
  const settings = getStaticTOMLValue(parseTOML(await readFile(conductorSettingsPath, "utf8")));
  assert.equal(settings.codex_provider, "default", "configure selects Conductor's CLI authentication mode");
  assert.equal(settings.codex_executable_path, wrapper, "configure selects the generated executable in Conductor's real settings file");
  return settings.codex_executable_path;
}
const listModels = async () => {
  const executablePath = await selectedExecutable();
  return withSidecar(({ rpc }) => rpc("listCodexModels", {
    type: "list_codex_models", agentType: "codex", cwd: home, codexExecutablePath: executablePath,
  }));
};
async function inference(selected) {
  expectedInferenceModel = selected.id;
  const before = requests.length;
  const executablePath = await selectedExecutable();
  await withSidecar(async ({ rpc, events, waitFor }) => {
    const id = `synthetic-${requests.length}`;
    await rpc("query", { type: "query", id, agentType: "codex", message: "Synthetic integration probe",
      prompt: "Reply with the synthetic gateway result without using tools.", options: {
        cwd: home, model: selected.id, codexExecutablePath: executablePath,
        initialCodexApprovalPolicy: "never", initialCodexSandboxMode: "read-only",
        localExecutionMcpEnabled: false, getDiffCommentsEnabled: false, progressUpdatesEnabled: false,
      } });
    const terminal = await waitFor(() => events.find((message) => {
      if (message.method === "queryError") return true;
      const event = message.params?.event?.rawPayload?.event;
      return event?.type === "turn.completed" || event?.type === "turn.failed";
    }), "Conductor synthetic turn completion");
    assert.notEqual(terminal.method, "queryError", JSON.stringify(terminal));
    const event = terminal.params.event.rawPayload.event;
    assert.equal(event.type, "turn.completed", JSON.stringify(event));
    assert.equal(event.conductor_sdk_metadata?.model, selected.id);
    assert.ok(events.some((message) => {
      const item = message.params?.event?.rawPayload?.event?.item;
      return item?.type === "agentMessage" && item.text === answer;
    }), "Conductor receives the completed assistant reply from the Responses stream");
  });
  assert.ok(requests.slice(before).some((request) => request.method === "POST" && request.model === selected.id),
    "the actual gateway request uses the exact selected pool, route, or provider ID");
}

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  await mkdir(normalCodex, { recursive: true });
  await writeFile(join(normalCodex, "config.toml"), normalConfig);
  await writeFile(join(normalCodex, "auth.json"), normalAuth, { mode: 0o600 });
  await mkdir(dirname(conductorSettingsPath), { recursive: true });
  await writeFile(conductorSettingsPath, originalConductorSettings);
  const version = (await run(codex, ["--version"], { cwd: home, env, timeout: 5000 })).stdout.match(/codex-cli (\d+\.\d+\.\d+)/)?.[1];
  assert.ok(version, "the selected bundled executable identifies as Codex");
  const runtimeVersion = (await run(runtime, ["--version"], { cwd: home, env, timeout: 5000 })).stdout.trim();
  // Preserve the real install and point only the disposable HOME's expected
  // binary cache at it, so the adapter follows its normal discovery path.
  const cachedBinary = join(home, "Library", "Application Support", "com.conductor.app", "agent-binaries", "codex", version, "codex");
  await mkdir(dirname(cachedBinary), { recursive: true });
  await symlink(codex, cachedBinary);
  await mkdir(opperHome, { recursive: true });
  async function saveSlot(key) {
    await writeFile(configPath, JSON.stringify({ version: 1, defaultKey: "fixture", telemetry: { enabled: false },
      keys: { fixture: { apiKey: key, baseUrl, orgId: 42, source: "manual",
        defaultProjectUuid: "22222222-2222-4222-8222-222222222222" } } }), { mode: 0o600 });
  }
  await saveSlot(initialKey);
  const cliOptions = { cwd: home, env, timeout: 30000, maxBuffer: 4_000_000 };
  const invokeCLI = (args) => run(cliBinary || process.execPath, cliBinary ? args : [cli, ...args], cliOptions);
  const configure = (model, modelKinds) => invokeCLI(["--no-telemetry", "--key", "fixture", "--project-uuid", projectUuid,
    "agents", "configure", "conductor", ...(model ? ["--model", model] : []),
    ...(modelKinds ? ["--model-kinds", modelKinds] : [])]);
  const configured = await configure(poolID);
  assert.ok(configured.stdout.includes(wrapper), "the operator receives the actual generated executable path");
  await access(wrapper, constants.X_OK);
  await selectedExecutable();
  const configuredSettings = await readFile(conductorSettingsPath, "utf8");
  assert.ok(configuredSettings.includes('# Existing Conductor preferences\n'));
  assert.ok(configuredSettings.includes('wrap_lines = true # Preserve this preference\n'));
  assert.ok(configuredSettings.includes('[git]\nbranch_prefix_custom = "keep-this-prefix"\n'));
  // A real user preference edit made after setup must survive both repeated
  // reconfiguration and restoration of only the two owned settings fields.
  await writeFile(conductorSettingsPath, configuredSettings.replace('terminal_font_size = "14"', 'terminal_font_size = "16"'));
  if (cliBinary) {
    await access(join(dirname(wrapper), "node"), constants.X_OK);
    await access(join(dirname(wrapper), "NODE-LICENSE"));
  }
  const models = await listModels();
  const selected = models.models.find((model) => model.id === routeID);
  assert.ok(selected && !selected.hidden, "the generated route is visible in Conductor's actual model discovery");
  assert.match(selected.displayName, /Conductor Synthetic Route/);
  const pool = models.models.find((model) => model.id === poolID);
  assert.ok(pool && !pool.hidden, "the compact default exposes a tool-capable pool in real Conductor discovery");
  assert.match(pool.displayName, /Conductor Synthetic Pool/);
  assert.ok(!models.models.some((model) => model.id === additionalID), "provider models are absent from the compact default");
  assert.ok(requests.some((request) => request.path === "/v3/compat/models"), "the built CLI fetches the authorized compat catalog");
  await inference(selected);
  await inference(pool);
  assert.ok(requests.some((request) => request.method === "POST" && request.auth === `Bearer ${initialKey}`));

  // No reconfigure: a new actual Conductor process must use the changed stored
  // key, rather than a credential copied into its executable or config.
  activeKey = rotatedKey;
  await saveSlot(rotatedKey);
  const rotationStart = requests.length;
  await inference(selected);
  const rotated = requests.slice(rotationStart).filter((request) => request.method === "POST");
  assert.ok(rotated.length > 0 && rotated.every((request) => request.auth === `Bearer ${rotatedKey}`));

  await configure(routeID, "all");
  const expanded = await listModels();
  assert.ok(expanded.models.some((model) => model.id === additionalID && !model.hidden),
    "--model-kinds all makes provider models selectable alongside pools and routes");
  assert.ok(expanded.models.some((model) => model.id === poolID));
  assert.ok(expanded.models.some((model) => model.id === routeID));

  await configure(routeID, "pools,routes");
  const compactAgain = await listModels();
  assert.ok(compactAgain.models.some((model) => model.id === additionalID),
    "reconfiguration retains previously exposed provider selections for existing sessions");
  assert.ok(compactAgain.models.some((model) => model.id === poolID));
  assert.ok(compactAgain.models.some((model) => model.id === routeID));

  await configure(additionalID);
  const explicitModels = await listModels();
  const explicit = explicitModels.models.find((model) => model.id === additionalID);
  assert.ok(explicit && !explicit.hidden, "an explicitly selected provider remains an exact-ID exception to the compact default");
  assert.ok(explicitModels.models.some((model) => model.id === poolID));
  assert.ok(explicitModels.models.some((model) => model.id === routeID));
  await inference(explicit);

  // The old backend ignored format=codex and returned data[]. Upgrading that
  // same owned installation must prefer native discovery and retain its full
  // authorized inventory, because older sessions may reference deployments.
  nativeFormat = true;
  await configure();
  const managedStatePath=join(dirname(wrapper),"state.json");
  let managedState=JSON.parse(await readFile(managedStatePath,"utf8"));
  assert.ok(managedState.catalogUrl.includes("format=codex"));
  assert.equal(new URL(managedState.catalogUrl).searchParams.has("type"),false);
  await assert.rejects(access(join(dirname(wrapper),"catalog.json")),{code:"ENOENT"});
  const beforeDisabled=requests.length;
  await assert.rejects(run(wrapper,["--disable","api_key_model_discovery","--version"],cliOptions),error=>/reconfigure/.test(error.stderr));
  assert.equal(requests.length,beforeDisabled,"a disabled native wrapper fails before starting catalog discovery");
  let nativeStart=requests.length;
  const migrated=await listModels();
  assert.ok(migrated.models.some(model=>model.id===additionalID));
  assert.ok(migrated.models.some(model=>model.id===unselectedID));
  assert.ok(requests.slice(nativeStart).some(request=>request.path.includes("format=codex")&&request.path.includes("client_version=")),"Codex itself fetched the native catalog");
  await configure(undefined,"pools,routes");
  managedState=JSON.parse(await readFile(managedStatePath,"utf8"));
  assert.equal(new URL(managedState.catalogUrl).searchParams.has("type"),false,"refresh must preserve previously exposed provider IDs");
  // Server-side catalog changes are visible to a new actual Conductor process
  // without regenerating the wrapper or running another configure command.
  nativeNewRoute=true;nativeStart=requests.length;
  assert.ok((await listModels()).models.some(model=>model.id==="dynamic/new-native-route"));
  assert.ok(requests.slice(nativeStart).some(request=>request.path.includes("client_version=")));
  activeKey=initialKey;await saveSlot(initialKey);
  await inference(migrated.models.find(model=>model.id===additionalID));
  const stateBefore=await readFile(managedStatePath,"utf8"), launcherBefore=await readFile(join(dirname(wrapper),"launcher.mjs"),"utf8");
  denied=true;await assert.rejects(configure());denied=false;
  assert.equal(await readFile(managedStatePath,"utf8"),stateBefore);
  assert.equal(await readFile(join(dirname(wrapper),"launcher.mjs"),"utf8"),launcherBefore);

  // A fresh native installation can safely use the compact policy plus one
  // exact selected deployment exception. Removal restores the same preferences.
  await invokeCLI(["--no-telemetry","agents","remove","conductor"]);
  await configure(additionalID);
  managedState=JSON.parse(await readFile(managedStatePath,"utf8"));
  assert.equal(new URL(managedState.catalogUrl).searchParams.get("type"),"pool,dynamic_route");
  const freshNative=await listModels();
  assert.ok(freshNative.models.some(model=>model.id===additionalID));
  assert.ok(!freshNative.models.some(model=>model.id===unselectedID));
  await inference(freshNative.models.find(model=>model.id===additionalID));
  await configure(additionalID,"all");
  assert.ok((await listModels()).models.some(model=>model.id===unselectedID));
  await configure();
  assert.equal(new URL(JSON.parse(await readFile(managedStatePath,"utf8")).catalogUrl).searchParams.has("type"),false);

  await invokeCLI(["--no-telemetry", "agents", "remove", "conductor"]);
  await assert.rejects(access(wrapper), { code: "ENOENT" });
  await assert.rejects(run(wrapper, ["--version"], cliOptions), { code: "ENOENT" });
  assert.equal(await readFile(conductorSettingsPath, "utf8"),
    originalConductorSettings.replace('terminal_font_size = "14"', 'terminal_font_size = "16"'),
    "remove restores the previous provider/executable and preserves unrelated comments and edits");
  assert.equal(await readFile(join(normalCodex, "config.toml"), "utf8"), normalConfig);
  assert.equal(await readFile(join(normalCodex, "auth.json"), "utf8"), normalAuth);
  assert.ifError(fixtureError);
  console.log(`Conductor ${runtimeVersion}; Codex ${version}: legacy fallback; native API discovery, fresh/upgrade catalog policy, runtime refresh, exact SSE completion, provider exception/all, key rotation, auth failure preservation, project headers, removal restoration and normal Codex preservation passed. Fake keys and loopback only.`);
} finally {
  await Promise.all([...children].map(stop));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
  await rm(temporary, { recursive: true, force: true });
}
