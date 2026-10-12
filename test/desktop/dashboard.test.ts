import { createServer, request } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopDashboard } from "../../src/desktop/dashboard.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(cleanup.splice(0).map((close) => close())); });

async function fixture(beforeCreate?: () => Promise<void>, port = 0) {
  const state = {sessions: [] as Array<{id: string; name: string; project: string; archivedAt?: string}>, activeId: null as string | null, activeRequests: 0};
  const dashboard = createDesktopDashboard({
    getState: () => state,
    createSession: async (name, project) => {await beforeCreate?.(); const id = `sess_${state.sessions.length + 1}`; state.sessions.push({id, name, project}); state.activeId = id;},
    activateSession: async (id) => {if (!state.sessions.some((session) => session.id === id && !session.archivedAt)) throw new Error("private-secret"); state.activeId = id;},
    pauseSession: async () => {state.activeId = null;},
    archiveSession: async (id) => {const session = state.sessions.find((entry) => entry.id === id); if (!session) throw new Error("private-secret"); session.archivedAt = "2026-10-12T21:00:00.000Z"; if (state.activeId === id) state.activeId = null;},
    restoreSession: async (id) => {const session = state.sessions.find((entry) => entry.id === id); if (!session) throw new Error("private-secret"); delete session.archivedAt;},
  });
  const server = createServer((req, res) => {res.setHeader("Connection", "close"); if (!dashboard.handle(req, res)) {res.writeHead(404); res.end();}});
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  let closed = false;
  const close = async () => {if (closed) return; closed = true; await new Promise<void>((resolve) => {server.closeAllConnections(); server.close(() => resolve());});};
  cleanup.push(close);
  const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const launch = dashboard.createLaunchUrl(origin);
  const opened = await fetch(launch, {redirect: "manual"});
  const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
  const api = (path: string, payload?: object, headers: Record<string, string> = {}) => fetch(origin + path, {
    method: payload === undefined ? "GET" : "POST",
    headers: {Cookie: cookie, Origin: origin, "Content-Type": "application/json", ...headers},
    ...(payload === undefined ? {} : {body: JSON.stringify(payload)}),
  });
  return {dashboard, state, origin, launch, opened, cookie, api, close};
}

describe("desktop dashboard over real HTTP", () => {
  it("consumes a short-lived one-use launch ticket and separates browser auth from inference bearer", async () => {
    const f = await fixture();
    expect(f.opened.status).toBe(303);
    expect(f.opened.headers.get("location")).toBe("/");
    expect(f.opened.headers.get("set-cookie")).toContain("Path=/api; HttpOnly; SameSite=Strict");
    expect((await fetch(f.launch, {redirect: "manual"})).status).toBe(401);
    expect((await fetch(f.origin + "/api/sessions", {headers: {Authorization: "Bearer local-secret"}})).status).toBe(401);
    expect((await f.api("/api/sessions")).status).toBe(200);
    const now = Date.now();
    const expiring = f.dashboard.createLaunchUrl(f.origin);
    vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
    expect((await fetch(expiring, {redirect: "manual"})).status).toBe(401);
  });

  it("creates, selects, and pauses saved sessions without exposing unrelated state", async () => {
    const f = await fixture();
    expect((await f.api("/api/sessions", {name: "Acme work", project: "acme"})).status).toBe(200);
    await f.api("/api/sessions", {name: "Beta work", project: "beta"});
    expect(await (await f.api("/api/sessions")).json()).toMatchObject({activeId: "sess_2", sessions: [{name: "Acme work"}, {project: "beta"}]});
    await f.api("/api/sessions/sess_1/activate", {});
    expect(f.state.activeId).toBe("sess_1");
    await f.api("/api/pause", {});
    expect(f.state.activeId).toBeNull();
    expect(f.state.sessions).toHaveLength(2);
    const invalid = await f.api("/api/sessions/sess_missing/activate", {});
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain("private-secret");
  });

  it("archives inactive and active sessions, retains their details, and restores without selecting", async () => {
    const f = await fixture();
    await f.api("/api/sessions", {name: "Acme work", project: "acme"});
    await f.api("/api/sessions", {name: "Beta work", project: "beta"});
    const archive = await f.api("/api/sessions/sess_1/archive", {});
    expect(archive.status).toBe(200);
    expect(await archive.json()).toMatchObject({activeId: "sess_2", sessions: [{id: "sess_1", name: "Acme work", project: "acme", archivedAt: "2026-10-12T21:00:00.000Z"}, {id: "sess_2"}]});
    const invalid = await f.api("/api/sessions/sess_1/activate", {});
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain("private-secret");
    const end = await f.api("/api/sessions/sess_2/archive", {});
    expect((await end.json()).activeId).toBeNull();
    const restored = await f.api("/api/sessions/sess_1/restore", {});
    expect(restored.status).toBe(200);
    const state = await restored.json();
    expect(state.activeId).toBeNull();
    expect(state.sessions).toHaveLength(2);
    expect(state.sessions[0]).toEqual({id: "sess_1", name: "Acme work", project: "acme"});
    expect((await f.api("/api/sessions/sess_1/activate", {})).status).toBe(200);
    expect(f.state.activeId).toBe("sess_1");
  });

  it.each(["archive", "restore"])("guards %s with browser auth, method, origin, JSON and body limits", async (action) => {
    const f = await fixture();
    await f.api("/api/sessions", {name: "Acme work", project: "acme"});
    const path = `/api/sessions/sess_1/${action}`;
    expect((await fetch(f.origin + path, {method: "POST", headers: {Origin: f.origin, "Content-Type": "application/json"}, body: "{}"})).status).toBe(401);
    expect((await f.api(path)).status).toBe(405);
    expect((await f.api(path, {}, {Origin: "https://attacker.example"})).status).toBe(403);
    expect((await f.api(path, {}, {"Content-Type": "text/plain"})).status).toBe(415);
    expect((await f.api(path, {unused: "x".repeat(9000)})).status).toBe(413);
    expect((await f.api(`/api/sessions/missing/${action}`, {})).status).toBe(400);
    expect(f.state.sessions[0]!.archivedAt).toBeUndefined();
    expect(f.state.activeId).toBe("sess_1");
  });

  it("rejects cross-origin writes, missing origins, non-JSON bodies, and oversized input", async () => {
    const f = await fixture();
    expect((await f.api("/api/sessions", {name: "bad", project: "bad"}, {Origin: "https://attacker.example"})).status).toBe(403);
    expect((await f.api("/api/pause", {}, {Origin: ""})).status).toBe(403);
    expect((await f.api("/api/sessions", {name: "bad", project: "bad"}, {"Content-Type": "text/plain"})).status).toBe(415);
    expect((await f.api("/api/sessions", {name: "x".repeat(9000), project: "bad"})).status).toBe(413);
    expect((await f.api("/api/sessions", {name: " ", project: "bad"})).status).toBe(400);
    expect(f.state.sessions).toHaveLength(0);
  });

  it("serves static assets without credentials, with browser security headers and no external dependencies", async () => {
    const f = await fixture();
    const page = await fetch(f.origin);
    const html = await page.text();
    expect(html).toContain("Sessions");
    expect(html).toContain('list="project-options"');
    expect(html).not.toContain(f.cookie.split("=")[1]);
    expect(html).not.toMatch(/https?:\/\//);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("content-security-policy")).toContain("font-src 'self'");
    expect(page.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const script = await (await fetch(f.origin + "/app.js")).text();
    expect(script).toContain("textContent");
    expect(script).not.toContain("innerHTML");
    expect(script).toContain("2000");
    const font = await fetch(f.origin + "/inter-latin.woff2");
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(Buffer.from(await font.arrayBuffer()).subarray(0, 4).toString()).toBe("wOF2");
  });

  it("rejects hostile Host headers and refuses browser cookies on inference paths", async () => {
    const f = await fixture();
    const code = await new Promise<number>((resolve, reject) => {
      const req = request(f.origin + "/api/sessions", {headers: {Host: "attacker.example", Cookie: f.cookie}}, (res) => {res.resume(); resolve(res.statusCode!);});
      req.on("error", reject); req.end();
    });
    expect(code).toBe(403);
    expect((await fetch(f.origin + "/v3/compat/responses", {headers: {Cookie: f.cookie}})).status).toBe(404);
    expect(() => f.dashboard.createLaunchUrl("http://attacker.example")).toThrow();
  });

  it("serializes writes and keeps the queue usable after a rejected mutation", async () => {
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => {entered = resolve;});
    const gate = new Promise<void>((resolve) => {release = resolve;});
    const f = await fixture(async () => {entered(); await gate;});
    const create = f.api("/api/sessions", {name: "A", project: "a"});
    await started;
    const pause = f.api("/api/pause", {});
    release();
    expect((await create).status).toBe(200);
    expect((await pause).status).toBe(200);
    expect(f.state.activeId).toBeNull();
    expect((await f.api("/api/sessions/missing/activate", {})).status).toBe(400);
    expect((await f.api("/api/sessions/sess_1/activate", {})).status).toBe(200);
    expect(f.state.activeId).toBe("sess_1");
  });

  it("authenticates separate dashboard ports from one cookie jar and requires reopening after restart", async () => {
    const first = await fixture();
    const second = await fixture();
    const jar = new Map<string, string>();
    const remember = (cookie: string) => {const split = cookie.indexOf("="); jar.set(cookie.slice(0, split), cookie.slice(split + 1));};
    const cookies = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    remember(first.cookie); remember(second.cookie);
    expect(jar.size).toBe(2);
    for (const dashboard of [first, second]) {
      expect((await fetch(dashboard.origin + "/api/sessions", {headers: {Cookie: cookies()}})).status).toBe(200);
    }
    const port = Number(new URL(first.origin).port);
    await first.close();
    const restarted = await fixture(undefined, port);
    expect((await fetch(restarted.origin + "/api/sessions", {headers: {Cookie: cookies()}})).status).toBe(401);
    remember(restarted.cookie);
    expect((await fetch(restarted.origin + "/api/sessions", {headers: {Cookie: cookies()}})).status).toBe(200);
    expect((await fetch(second.origin + "/api/sessions", {headers: {Cookie: cookies()}})).status).toBe(200);
  });
});
