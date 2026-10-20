// After npm run build: PI_BIN=/path/to/pi node test/integration/pi-model-catalog.mjs
// Real Pi provider loading and inference, isolated homes, fake credentials,
// loopback catalog/SSE responses. No account access or external inference.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const run = (...args) => {
  const pending = exec(...args);
  // The launcher intentionally inherits stdin. Close its pipe so Pi sees EOF
  // rather than waiting for additional piped prompt input before --print.
  pending.child.stdin.end();
  return pending;
};
const binary = process.env.PI_BIN || "pi";
const directory = await mkdtemp(join(tmpdir(), "opper-pi-catalog-"));
const providerID = "vendor/deployment";
const poolID = "claude-opus-4-7";
const routeID = "dynamic/team";
const requests = [];
let denied = false;
let withdrawn = false;
const catalog = () => [
  { id: poolID, context_length: 128000, opper: { kind: "pool", capabilities: ["tools"], max_output_tokens: 4096 } },
  { id: routeID, context_length: 128000, opper: { kind: "dynamic_route", display_name: "Team Route", capabilities: ["tools"], max_output_tokens: 4096, pricing: { kind: "variable" } } },
  ...(!withdrawn ? [{ id: providerID, context_length: 128000, opper: { kind: "model", capabilities: ["tools"], max_output_tokens: 4096 } }] : []),
  { id: "vendor/embedding", context_length: 8192, opper: { kind: "model", type: "embedding", capabilities: [], max_output_tokens: 1024 } },
];
const server = createServer(async (request, response) => {
  if (request.headers.authorization !== "Bearer synthetic") { response.writeHead(403).end(); return; }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  requests.push({ path: request.url, method: request.method, body, headers: request.headers });
  if (request.method === "GET" && request.url === "/v3/compat/models") {
    response.writeHead(denied ? 403 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(denied ? { error: { message: "Denied" } } : { data: catalog() }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/v3/compat/chat/completions") { response.writeHead(404).end(); return; }
  if (!catalog().some(model => model.id === body.model)) {
    response.writeHead(403, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Synthetic model unavailable" } }));
    return;
  }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [delta, finish_reason] of [[{ role: "assistant", content: "catalog-runtime-ok" }, null], [{}, "stop"]]) {
    response.write(`data: ${JSON.stringify({ id: "synthetic-response", object: "chat.completion.chunk", created: 1, model: body.model,
      choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
});

try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const rootURL = `http://127.0.0.1:${server.address().port}`;
  const agentDir = join(directory, ".pi", "agent");
  const configPath = join(agentDir, "models.json");
  const settingsPath = join(agentDir, "settings.json");
  await mkdir(agentDir, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "TMPDIR", "LANG", "NODE_EXTRA_CA_CERTS"].includes(key)));
  Object.assign(env, {
    HOME: directory, USERPROFILE: directory, OPPER_HOME: join(directory, ".opper"),
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", OPPER_TELEMETRY: "off",
    OPPER_API_KEY: "synthetic", OPPER_BASE_URL: rootURL,
    XDG_CONFIG_HOME: join(directory, ".config"), XDG_DATA_HOME: join(directory, ".local", "share"),
    XDG_CACHE_HOME: join(directory, ".cache"), XDG_STATE_HOME: join(directory, ".local", "state"),
    ...(binary.includes("/") ? { PATH: `${dirname(binary)}:${env.PATH}` } : {}),
  });
  const options = { cwd: directory, env, timeout: 45000, maxBuffer: 8_000_000 };
  const adapterURL = pathToFileURL(join(process.cwd(), "dist", "agents", "pi.js")).href;
  const driver = join(directory, "adapter.mjs");
  await writeFile(driver, `import { pi } from ${JSON.stringify(adapterURL)};\nconst input = JSON.parse(process.argv[2]);\nif (input.action === "configure") await pi.configure(input.options); else process.exitCode = await pi.spawn(input.args, input.routing);\n`);
  const invoke = input => run(process.execPath, [driver, JSON.stringify(input)], options);
  const configure = (extra = {}) => invoke({ action: "configure", options: { apiKey: "synthetic", baseUrl: rootURL, ...extra } });
  const routing = { apiBaseUrl: rootURL, baseUrl: `${rootURL}/v3/compat`, apiKey: "synthetic", model: poolID, compatShape: "openai" };
  const safeFlags = ["--offline", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes"];
  const launch = (args, extra = {}) => invoke({ action: "launch", args: [...safeFlags, ...args], routing: { ...routing, ...extra } });
  const list = async () => (await run(binary, [...safeFlags, "--list-models", "opper"], options)).stdout;
  const ids = async () => JSON.parse(await readFile(configPath, "utf8")).providers.opper.models.map(model => model.id);
  const inferenceArgs = ["--mode", "json", "--no-tools", "--print", "--no-session", "respond"];
  const infer = async (args = inferenceArgs, extra = {}) => {
    const before = requests.filter(request => request.method === "POST").length;
    const result = await launch(args, extra);
    assert.match(result.stdout, /catalog-runtime-ok/);
    const calls = requests.filter(request => request.method === "POST");
    assert.equal(calls.length, before + 1);
    return calls.at(-1);
  };
  console.log(`Pi ${(await run(binary, ["--version"], options)).stdout.trim()}`);

  // Pi's generic compatible provider does not discover arbitrary endpoint models.
  await writeFile(configPath, JSON.stringify({ providers: { opper: { baseUrl: `${rootURL}/v3/compat`, api: "openai-completions", apiKey: "${OPPER_API_KEY}", authHeader: true } } }));
  assert.ok(!(await list()).includes(providerID));
  assert.equal(requests.length, 0, "native compatible provider must not fetch /models implicitly");
  await rm(configPath);
  await configure();
  assert.deepEqual(await ids(), [routeID, poolID]);
  let picker = await list();
  assert.ok(picker.includes(poolID) && picker.includes(routeID) && !picker.includes(providerID));
  const launchPicker = (await launch(["--list-models", "opper"])).stdout;
  assert.ok(launchPicker.includes(poolID) && launchPicker.includes(routeID) && !launchPicker.includes(providerID));
  assert.ok((await launch(["--list-models", "opper"], { modelKinds: "all" })).stdout.includes(providerID));
  assert.equal((await infer()).body.model, poolID);

  // Explicit deployments remain accessible via either launcher or native Pi args.
  assert.equal((await infer(inferenceArgs, { model: providerID, modelOverride: providerID })).body.model, providerID);
  assert.equal((await infer(["--model", providerID, ...inferenceArgs])).body.model, providerID);
  const beforeMissing = requests.filter(request => request.method === "POST").length;
  await assert.rejects(launch(inferenceArgs, { model: "withdrawn", modelOverride: "withdrawn" }));
  assert.equal(requests.filter(request => request.method === "POST").length, beforeMissing);
  // Pi permits opaque custom model IDs and asks the endpoint to resolve them.
  // Preserve that native path; a rejection must not retry another catalog model.
  const missing = await launch(["--model", "provider-id-that-does-not-exist-at-all", ...inferenceArgs]).catch(error => error);
  assert.match(`${missing.stdout}${missing.stderr}`, /Synthetic model unavailable/);
  const missingCalls = requests.filter(request => request.method === "POST").slice(beforeMissing);
  assert.ok(missingCalls.length > 0 && missingCalls.every(request => request.body.model === "provider-id-that-does-not-exist-at-all"));

  await configure({ modelKinds: "all" });
  assert.ok((await list()).includes(providerID));
  const settings = JSON.stringify({ defaultProvider: "opper", defaultModel: providerID, theme: "dark", retry: { enabled: false } });
  await writeFile(settingsPath, settings);
  await configure();
  assert.ok((await ids()).includes(providerID), "upgrade must retain prior authorized deployments");
  assert.equal(await readFile(settingsPath, "utf8"), settings);
  assert.equal((await infer()).body.model, providerID, "launch must respect saved Pi Opper default");
  const plain = await run(binary, [...safeFlags, ...inferenceArgs], options);
  assert.match(plain.stdout, /catalog-runtime-ok/);
  assert.equal(requests.filter(request => request.method === "POST").at(-1).body.model, providerID);

  await writeFile(settingsPath, settings.replace(providerID, "withdrawn"));
  assert.equal((await infer(["--models", `opper/${providerID}`, ...inferenceArgs])).body.model, providerID);
  await writeFile(settingsPath, settings);

  // Ordinary Opper launch keeps its existing precedence over project defaults,
  // including untrusted/empty settings; it must never route to another provider.
  const projectSettings = join(directory, ".pi", "settings.json");
  await writeFile(projectSettings, JSON.stringify({ defaultProvider: "opper", defaultModel: routeID }));
  assert.equal((await infer(["--no-approve", ...inferenceArgs])).body.model, providerID);
  assert.equal((await infer(["--approve", ...inferenceArgs])).body.model, providerID);
  await writeFile(projectSettings, "{}");
  assert.equal((await infer(["--no-approve", ...inferenceArgs])).body.model, providerID);
  await rm(projectSettings);

  // A session selected through Pi's real session mechanism survives later launch.
  const sessionDir = join(directory, "sessions");
  await infer(["--session-dir", sessionDir, "--mode", "json", "--no-tools", "--print", "remember"], { model: providerID, modelOverride: providerID });
  await rm(settingsPath);
  assert.equal((await infer(["--continue", "--session-dir", sessionDir, "--mode", "json", "--no-tools", "--print", "continue"])).body.model, providerID);

  const before = await readFile(configPath, "utf8");
  denied = true;
  await assert.rejects(configure());
  assert.equal(await readFile(configPath, "utf8"), before);
  denied = false;
  await writeFile(settingsPath, settings);
  withdrawn = true;
  await assert.rejects(configure());
  await assert.rejects(launch(inferenceArgs));
  assert.equal(await readFile(configPath, "utf8"), before);
  assert.equal(await readFile(settingsPath, "utf8"), settings);
  assert.ok(requests.some(request => request.method === "POST" && request.headers["x-opper-trace-id"]), "real launch must execute the session extension");
  console.log("Pi: no native custom endpoint discovery; fresh picker, provider opt-in, saved selection, upgrade, native model, missing model, session resume, authorization failure and withdrawn selection passed. All inference used synthetic loopback SSE.");
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
