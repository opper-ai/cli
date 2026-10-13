import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { startDesktopBridge } from "../../src/desktop/bridge.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((fn) => fn())); });

async function upstream(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as {port: number}).port}`;
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function bridge(origin: string, extra: Partial<Parameters<typeof startDesktopBridge>[0]> = {}) {
  const result = await startDesktopBridge({ origin, token: "local-secret", resolveCredential: async () => "upstream-secret", ...extra });
  cleanup.push(() => result.close());
  return result;
}
function call(url: string, path = "/v3/compat/responses", opts: RequestInit = {}) {
  return fetch(`${url}${path}`, { method: "POST", headers: { Authorization: "Bearer local-secret", "Content-Type": "application/json" }, body: '{"input":"hello"}', ...opts });
}

describe("desktop bridge with real HTTP", () => {
  it("preserves Claude beta queries, provider headers, bytes and SSE attribution across a switch", async () => {
    const received: Array<{url: string; headers: IncomingMessage["headers"]; payload: string}> = [];
    const events: Array<{path: string}> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {release = resolve;});
    const origin = await upstream(async (req, res) => {
      received.push({url: req.url!, headers: req.headers, payload: (await body(req)).toString()});
      const first = received.length === 1;
      res.writeHead(200, {"Content-Type": "text/event-stream", "request-id": "claude-request", "anthropic-ratelimit-requests-remaining": "7"});
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      if (first) await gate;
      res.end("event: message_stop\ndata: {}\n\n");
    });
    const proxy = await bridge(origin, {initialTags: {project: "A"}, onRequest: (event) => events.push(event)});
    const firstId = proxy.status().sessionId;
    const payload = '{ "model": "claude-sonnet-5", "stream": true }\n';
    const query = "?beta=true&option=%2F&option=two&empty=&encoded=%23";
    const response = await call(proxy.url, `/v3/compat/v1/messages${query}`, {body: payload, headers: {Authorization: "Bearer local-secret", "Content-Type": "application/json", "anthropic-beta": "feature-2026-01-01", "anthropic-version": "2023-06-01"}});
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("request-id")).toBe("claude-request");
    expect(response.headers.get("anthropic-ratelimit-requests-remaining")).toBe("7");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("message_start");
    const second = proxy.setTags({project: "B"});
    expect(await (await call(proxy.url, "/v3/compat/v1/messages?beta=true")).text()).toContain("message_stop");
    release();
    let ending = "";
    while (true) {const part = await reader.read(); if (part.done) break; ending += new TextDecoder().decode(part.value);}
    expect(ending).toContain("message_stop");
    expect(received.map((item) => item.url)).toEqual([`/v3/session/${firstId}/project:A/v1/messages${query}`, `/v3/session/${second.sessionId}/project:B/v1/messages?beta=true`]);
    expect(received[0]!.payload).toBe(payload);
    expect(received[0]!.headers).toMatchObject({authorization: "Bearer upstream-secret", "anthropic-beta": "feature-2026-01-01", "anthropic-version": "2023-06-01"});
    expect(events.map((event) => event.path)).toEqual(["/v3/compat/v1/messages", "/v3/compat/v1/messages"]);
  });

  it("preserves model pagination queries while rejecting raw encoded paths and queried control routes", async () => {
    const forwarded: string[] = [];
    const origin = await upstream(async (req, res) => {forwarded.push(req.url!); await body(req); res.end('{"data":[]}');});
    const proxy = await bridge(origin);
    const modelPath = "/v3/compat/v1/models?limit=2&after=a%2Fb";
    expect(await (await call(proxy.url, modelPath, {method: "GET", body: null})).text()).toBe('{"data":[]}');
    const rawModelPath = "/v3/compat/models?literal=a'b&after=a%2fb";
    const rawModel = await new Promise<IncomingMessage>((resolve, reject) => {
      const client = request(new URL(proxy.url), {path: rawModelPath, method: "GET", headers: {Authorization: "Bearer local-secret"}}, resolve);
      client.on("error", reject); client.end();
    });
    expect((await body(rawModel)).toString()).toBe('{"data":[]}');
    expect(forwarded).toEqual([modelPath, rawModelPath]);
    const before = proxy.status();
    const rawStatus = (target: string, method = "POST", token = "local-secret") => new Promise<number>((resolve, reject) => {
      const url = new URL(proxy.url);
      const client = request({hostname: url.hostname, port: url.port, path: target, method, headers: {Authorization: `Bearer ${token}`}}, (response) => {response.resume(); resolve(response.statusCode!);});
      client.on("error", reject); client.end(method === "POST" ? "{}" : undefined);
    });
    for (const target of ["/v3/compat/v1/%6dessages?beta=true", "/v3/compat/v1/messages/../messages?beta=true", "/v3/compat/%2e%2e/v1/messages?beta=true", "/v3/compat/v1%2Fmessages?beta=true", "/v3/compat/v1\\messages?beta=true", "//attacker.example/v3/compat/v1/messages?beta=true", "http://attacker.example/v3/compat/v1/messages?beta=true", "/v3/compat/v1/messages#fragment", "/v3/compat/v1/messages?beta=true#fragment", "/unknown?beta=true", "/opper/context?ignored=true"]) {
      expect(await rawStatus(target)).toBe(404);
    }
    expect(await rawStatus("/opper/status?ignored=true", "GET")).toBe(404);
    expect(await rawStatus("/v3/compat/v1/messages?beta=true", "POST", "invalid")).toBe(401);
    expect(proxy.status()).toEqual(before);
    expect(forwarded).toEqual([modelPath, rawModelPath]);
  });

  it("switches A to B to clear, preserves bytes, and replaces client attribution/auth headers", async () => {
    const seen: Array<{path: string; headers: IncomingMessage["headers"]; payload: string}> = [];
    const origin = await upstream(async (req, res) => {
      seen.push({path: req.url!, headers: req.headers, payload: (await body(req)).toString()});
      res.writeHead(201, {"Content-Type": "application/json", "request-id": "provider-123"});
      res.end('{"ok":true}');
    });
    let credentials = 0;
    const proxy = await bridge(origin, { projectUuid: "project-scope", initialTags: {project: "A"}, resolveCredential: async () => `upstream-${++credentials}` });
    const raw = '{ "input": "hello", "unknown": [1, 2] }\n';
    const response = await call(proxy.url, undefined, {body: raw, headers: {Authorization: "Bearer local-secret", "x-api-key": "client-key", "X-Opper-Tags": "bad", "X-Opper-Project": "wrong", "X-Opper-Trace-Id": "wrong-trace"}});
    expect(response.status).toBe(201);
    expect(response.headers.get("request-id")).toBe("provider-123");
    expect(await response.text()).toBe('{"ok":true}');
    const first = proxy.status();
    const second = proxy.setTags({project: "B"});
    await (await call(proxy.url, "/v3/compat/v1/messages")).text();
    const third = proxy.setTags({});
    await (await call(proxy.url, "/v3/compat/chat/completions")).text();
    expect(seen.map((item) => item.path)).toEqual([
      `/v3/session/${first.sessionId}/project:A/responses`,
      `/v3/session/${second.sessionId}/project:B/v1/messages`,
      `/v3/session/${third.sessionId}/chat/completions`,
    ]);
    expect(new Set([first.sessionId, second.sessionId, third.sessionId]).size).toBe(3);
    expect(seen[0]!.payload).toBe(raw);
    expect(seen.map((item) => item.headers.authorization)).toEqual(["Bearer upstream-1", "Bearer upstream-2", "Bearer upstream-3"]);
    expect(seen[0]!.headers["x-opper-project"]).toBe("project-scope");
    expect(seen[0]!.headers["x-api-key"]).toBeUndefined();
    expect(seen[0]!.headers["x-opper-tags"]).toBeUndefined();
    expect(seen[0]!.headers["x-opper-trace-id"]).toBeUndefined();
    expect(proxy.status()).toMatchObject({tags: {}, requests: 3, activeRequests: 0});
  });

  it("keeps an SSE request's original context while switching the next inference", async () => {
    let release!: () => void;
    const streamGate = new Promise<void>((resolve) => {release = resolve;});
    const paths: string[] = [];
    const origin = await upstream(async (req, res) => {
      await body(req);
      paths.push(req.url!);
      res.writeHead(200, {"Content-Type": "text/event-stream", "Cache-Control": "no-cache"});
      res.write('data: {"part":1}\n\n');
      if (paths.length === 1) await streamGate;
      res.end('data: [DONE]\n\n');
    });
    const proxy = await bridge(origin, {initialTags: {project: "A"}});
    const firstId = proxy.status().sessionId;
    const response = await call(proxy.url);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: {"part":1}');
    expect(proxy.status().activeRequests).toBe(1);
    const second = proxy.setTags({project: "B"});
    const next = await call(proxy.url);
    expect(await next.text()).toContain("[DONE]");
    release();
    let rest = "";
    while (true) {const chunk = await reader.read(); if (chunk.done) break; rest += new TextDecoder().decode(chunk.value);}
    expect(rest).toContain("[DONE]");
    expect(paths).toEqual([`/v3/session/${firstId}/project:A/responses`, `/v3/session/${second.sessionId}/project:B/responses`]);
  });

  it("snapshots context before credential resolution", async () => {
    const paths: string[] = [];
    const origin = await upstream(async (req, res) => { paths.push(req.url!); await body(req); res.end("ok"); });
    let entered!: () => void;
    let release!: () => void;
    const enteredGate = new Promise<void>((resolve) => {entered = resolve;});
    const credentialGate = new Promise<void>((resolve) => {release = resolve;});
    const proxy = await bridge(origin, {initialTags: {project: "A"}, resolveCredential: async () => {entered(); await credentialGate; return "secret";}});
    const firstId = proxy.status().sessionId;
    const pending = call(proxy.url);
    await enteredGate;
    proxy.setTags({project: "B"});
    release();
    expect(await (await pending).text()).toBe("ok");
    expect(paths).toEqual([`/v3/session/${firstId}/project:A/responses`]);
  });

  it("snapshots context before the body has finished uploading and filters connection headers", async () => {
    let arrived!: () => void;
    const arrival = new Promise<void>((resolve) => {arrived = resolve;});
    let path = "";
    let payload = "";
    let headers: IncomingMessage["headers"] = {};
    const origin = await upstream(async (req, res) => {
      path = req.url!; headers = req.headers; arrived();
      payload = (await body(req)).toString();
      res.writeHead(200, {Connection: "x-private", "x-private": "remove me", "x-provider": "keep me"});
      res.end("done");
    });
    const proxy = await bridge(origin, {initialTags: {project: "A"}});
    const firstId = proxy.status().sessionId;
    const pending = new Promise<IncomingMessage>((resolve, reject) => {
      const client = request(`${proxy.url}/v3/compat/responses`, {method: "POST", headers: {Authorization: "Bearer local-secret", Connection: "x-private", "x-private": "remove me", "x-provider": "keep me"}}, resolve);
      client.on("error", reject);
      client.write('{ "input": "hé');
      void arrival.then(() => {proxy.setTags({project: "B"}); client.end('llo" }\n');});
    });
    const response = await pending;
    expect((await body(response)).toString()).toBe("done");
    expect(path).toBe(`/v3/session/${firstId}/project:A/responses`);
    expect(payload).toBe('{ "input": "héllo" }\n');
    expect(headers["x-private"]).toBeUndefined();
    expect(headers["x-provider"]).toBe("keep me");
    expect(response.headers["x-private"]).toBeUndefined();
    expect(response.headers["x-provider"]).toBe("keep me");
  });

  it("authenticates controls, validates tags, and exposes no secrets", async () => {
    let forwarded = 0;
    const origin = await upstream((_req, res) => { forwarded++; res.end("ok"); });
    const proxy = await bridge(origin);
    expect((await call(proxy.url, undefined, {headers: {Authorization: "Bearer invalid"}})).status).toBe(401);
    expect((await call(proxy.url, "/opper/context", {headers: {Authorization: "Bearer invalid"}})).status).toBe(401);
    for (const tags of [{project: 42}, {"opper.reserved": "x"}, {session_id: "x"}, [], null, {"wrong key": "x"}]) {
      expect((await call(proxy.url, "/opper/context", {body: JSON.stringify({tags})})).status).toBe(400);
    }
    const changed = await call(proxy.url, "/opper/context", {body: JSON.stringify({tags: {project: "acme"}})});
    expect(await changed.json()).toMatchObject({tags: {project: "acme"}});
    const state = await call(proxy.url, "/opper/status", {method: "GET", body: null});
    expect(await state.text()).not.toMatch(/local-secret|upstream-secret|127\.0\.0\.1/);
    expect(forwarded).toBe(0);
    expect(() => proxy.setTags({session_id: "no"})).toThrow();
  });

  it("passes provider errors and model discovery but rejects arbitrary paths and redirects", async () => {
    const paths: string[] = [];
    const origin = await upstream(async (req, res) => {
      paths.push(req.url!); await body(req);
      if (req.url!.endsWith("/models")) {res.end('{"data":[]}'); return;}
      if (paths.length === 2) {res.writeHead(429, {"Content-Type": "application/json", "retry-after": "3"}); res.end('{"error":"rate limited"}'); return;}
      res.writeHead(307, {Location: "http://169.254.169.254/"}); res.end();
    });
    const proxy = await bridge(origin);
    expect(await (await call(proxy.url, "/v3/compat/v1/models", {method: "GET", body: null})).text()).toBe('{"data":[]}');
    const limited = await call(proxy.url);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("3");
    expect(await limited.text()).toBe('{"error":"rate limited"}');
    const redirected = await call(proxy.url);
    expect(redirected.status).toBe(502);
    expect(redirected.headers.get("location")).toBeNull();
    expect((await call(proxy.url, "/v3/compat/../../admin")).status).toBe(404);
    expect((await call(proxy.url, "/v3/compat/responses", {method: "GET", body: null})).status).toBe(405);
    expect(paths.length).toBe(3);
  });

  it("cancels the upstream stream when a client disconnects", async () => {
    let disconnected!: () => void;
    const closed = new Promise<void>((resolve) => {disconnected = resolve;});
    const origin = await upstream(async (req, res) => {
      await body(req);
      res.on("close", disconnected);
      res.writeHead(200, {"Content-Type": "text/event-stream"});
      res.write("data: started\n\n");
    });
    const events: Array<{status: number}> = [];
    const proxy = await bridge(origin, {onRequest: (event) => events.push(event)});
    const response = await call(proxy.url);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await closed;
    await new Promise((resolve) => setImmediate(resolve));
    expect(proxy.status().activeRequests).toBe(0);
    expect(events).toMatchObject([{status: 499}]);
  });

  it("validates configuration and reports credential failures without leaking them", async () => {
    const origin = await upstream((_req, res) => res.end("unused"));
    for (const port of [-1, 65536, 1.5]) await expect(bridge(origin, {port})).rejects.toThrow(/port/);
    await expect(bridge(origin, {token: " "})).rejects.toThrow(/token/);
    for (const invalid of ["file:///tmp/model", "https://user:password@example.com", "https://example.com/path", "https://example.com?next=foo"]) {
      await expect(bridge(invalid)).rejects.toThrow(/origin/);
    }
    const events: Array<{status: number}> = [];
    const proxy = await bridge(origin, {resolveCredential: async () => {throw new Error("credential-secret-value");}, onRequest: (event) => events.push(event)});
    const response = await call(proxy.url);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("credential-secret-value");
    expect(events).toMatchObject([{status: 502}]);
    expect(proxy.status().activeRequests).toBe(0);
    await proxy.close();
    await proxy.close();
  });

  it("pauses inference, permits discovery, and resumes stable named attribution sessions", async () => {
    const paths: string[] = [];
    const origin = await upstream(async (req, res) => {paths.push(req.url!); await body(req); res.end("ok");});
    const proxy = await bridge(origin, {initialContext: null});
    expect(proxy.status().paused).toBe(true);
    expect((await call(proxy.url)).status).toBe(409);
    expect(await (await call(proxy.url, "/v3/compat/models", {method: "GET", body: null})).text()).toBe("ok");
    const sessionA = {sessionId: "sess_11111111-1111-4111-8111-111111111111", tags: {project: "A"}};
    const sessionB = {sessionId: "sess_22222222-2222-4222-8222-222222222222", tags: {project: "B"}};
    proxy.setContext(sessionA);
    expect(await (await call(proxy.url)).text()).toBe("ok");
    proxy.setContext(sessionB);
    expect(await (await call(proxy.url)).text()).toBe("ok");
    proxy.pause();
    expect((await call(proxy.url)).status).toBe(409);
    proxy.setContext(sessionA);
    expect(proxy.status()).toMatchObject({...sessionA, paused: false});
    expect(await (await call(proxy.url)).text()).toBe("ok");
    expect(paths).toEqual(["/v3/compat/models", `/v3/session/${sessionA.sessionId}/project:A/responses`, `/v3/session/${sessionB.sessionId}/project:B/responses`, `/v3/session/${sessionA.sessionId}/project:A/responses`]);
    expect(() => proxy.setContext({sessionId: "../not-a-session", tags: {}})).toThrow();
  });

  it("permits a public local route handler without bypassing inference authentication", async () => {
    let forwarded = 0;
    const origin = await upstream((_req, res) => {forwarded++; res.end("ok");});
    const proxy = await bridge(origin, {handleLocalRequest: (req, res) => {
      if (req.url !== "/picker") return false;
      res.writeHead(200, {"Content-Type": "text/html"}); res.end("picker"); return true;
    }});
    expect(await (await fetch(`${proxy.url}/picker`)).text()).toBe("picker");
    expect((await fetch(`${proxy.url}/v3/compat/responses`, {method: "POST", body: "{}"})).status).toBe(401);
    expect((await fetch(`${proxy.url}/opper/status`)).status).toBe(401);
    expect(forwarded).toBe(0);
  });

  it("restores a saved context and lets existing streams finish while paused", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {release = resolve;});
    const paths: string[] = [];
    const origin = await upstream(async (req, res) => {
      paths.push(req.url!); await body(req);
      res.writeHead(200, {"Content-Type": "text/event-stream"});
      res.write("data: started\n\n");
      await gate;
      res.end("data: [DONE]\n\n");
    });
    const saved = {sessionId: "sess_11111111-1111-4111-8111-111111111111", tags: {project: "saved"}};
    const proxy = await bridge(origin, {initialContext: saved});
    const response = await call(proxy.url);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("started");
    proxy.pause();
    expect(proxy.status()).toMatchObject({paused: true, activeRequests: 1});
    expect((await call(proxy.url)).status).toBe(409);
    release();
    let result = "";
    while (true) {const chunk = await reader.read(); if (chunk.done) break; result += new TextDecoder().decode(chunk.value);}
    expect(result).toContain("[DONE]");
    expect(paths).toEqual([`/v3/session/${saved.sessionId}/project:saved/responses`]);
    expect(proxy.status()).toMatchObject({paused: true, activeRequests: 0});
  });
});
