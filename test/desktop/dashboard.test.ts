import { createServer, request } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
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
  let redirectTarget: string | undefined;
  const server = createServer((req, res) => {
    res.setHeader("Connection", "close");
    if (req.url === "/api/redirect-test" && redirectTarget) {res.writeHead(303, {Location: redirectTarget}); res.end(); return;}
    if (!dashboard.handle(req, res)) {res.writeHead(404); res.end();}
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  let closed = false;
  const close = async () => {if (closed) return; closed = true; await new Promise<void>((resolve) => {server.closeAllConnections(); server.close(() => resolve());});};
  cleanup.push(close);
  const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const launch = dashboard.createLaunchUrl(origin);
  const opened = await fetch(launch, {redirect: "manual"});
  const browserToken = new URL(opened.headers.get("location")!, origin).hash.slice(1);
  const api = (path: string, payload?: object, headers: Record<string, string> = {}) => fetch(origin + path, {
    method: payload === undefined ? "GET" : "POST",
    headers: {"X-Opper-Desktop-Browser": browserToken, Origin: origin, "Content-Type": "application/json", ...headers},
    redirect: "error", credentials: "omit",
    ...(payload === undefined ? {} : {body: JSON.stringify(payload)}),
  });
  return {dashboard, state, origin, launch, opened, browserToken, api, close, redirectTo: (url: string) => {redirectTarget = url;}};
}

/** Execute the served script with a minimal DOM; requests still use real HTTP.
 * Separate maps model browser sessionStorage isolation by full origin, including port.
 */
function runBrowserScript(script: string, origin: string, token: string, storage = new Map<string, string>()) {
  const node = (): any => ({classList: {toggle() {}}, addEventListener() {}, setAttribute() {}, append() {}, replaceChildren() {}, reset() {}, focus() {}, querySelector: () => node()});
  const elements = new Map<string, any>();
  const requests: Array<{url: string; options: RequestInit}> = [];
  const location = {origin, pathname: "/", search: "", hash: token ? `#${token}` : ""};
  let replaced = "";
  const context: any = {
    URL, TextEncoder, location,
    history: {replaceState(_state: unknown, _title: string, url: string) {replaced = url; location.hash = "";}},
    sessionStorage: {getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value)},
    document: {getElementById: (id: string) => {if (!elements.has(id)) elements.set(id, node()); return elements.get(id);}, createElement: () => node()},
    setInterval() {},
    fetch: (url: string, options: RequestInit) => {requests.push({url, options}); return fetch(url, {...options, headers: {...options.headers, Origin: origin}});},
  };
  runInNewContext(script, context);
  return {api: context.api as (path: string, payload?: object) => Promise<unknown>, storage, requests, location, replaced: () => replaced};
}

describe("desktop dashboard over real HTTP", () => {
  it("checks UTF-8 byte limits before creating Unicode sessions", async () => {
    const f = await fixture();
    const name = await f.api("/api/sessions", {name:"日".repeat(50),project:"acme"});
    expect(name.status).toBe(400);
    expect(await name.text()).toContain("Session name is too long");
    const project = await f.api("/api/sessions", {name:"Research",project:"😀".repeat(65)});
    expect(project.status).toBe(400);
    expect(await project.text()).toContain("Project is too long");
    expect(f.state.sessions).toHaveLength(0);
    expect((await f.api("/api/sessions", {name:"日".repeat(42),project:"😀".repeat(64)})).status).toBe(200);
    expect(f.state.sessions).toHaveLength(1);
    const script = await (await fetch(f.origin+"/app.js")).text();
    expect(script).toContain("new TextEncoder()");
    expect(script).toContain("Session name is too long");
  });
  it("consumes a short-lived one-use launch ticket and separates browser auth from inference bearer", async () => {
    const f = await fixture();
    expect(f.opened.status).toBe(303);
    expect(f.browserToken).toMatch(/^[a-f0-9]{64}$/);
    expect(f.opened.headers.get("location")).toBe(`/#${f.browserToken}`);
    expect(f.opened.headers.get("set-cookie")).toBeNull();
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
    expect(html).not.toContain(f.browserToken);
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
    expect(script).not.toContain(f.browserToken);
    const font = await fetch(f.origin + "/inter-latin.woff2");
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(Buffer.from(await font.arrayBuffer()).subarray(0, 4).toString()).toBe("wOF2");
  });

  it("rejects hostile Host headers and refuses browser credentials on inference paths", async () => {
    const f = await fixture();
    const code = await new Promise<number>((resolve, reject) => {
      const req = request(f.origin + "/api/sessions", {headers: {Host: "attacker.example", "X-Opper-Desktop-Browser": f.browserToken}}, (res) => {res.resume(); resolve(res.statusCode!);});
      req.on("error", reject); req.end();
    });
    expect(code).toBe(403);
    expect((await fetch(f.origin + "/v3/compat/responses", {headers: {"X-Opper-Desktop-Browser": f.browserToken}})).status).toBe(404);
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

  it("keeps parallel port credentials independent, permits reopening, and requires a new credential after restart", async () => {
    const first = await fixture();
    const second = await fixture();
    for (const dashboard of [first, second]) {
      expect((await dashboard.api("/api/sessions")).status).toBe(200);
    }
    expect(first.browserToken).not.toBe(second.browserToken);
    expect((await second.api("/api/sessions", undefined, {"X-Opper-Desktop-Browser": first.browserToken})).status).toBe(401);
    const reopened = await fetch(first.dashboard.createLaunchUrl(first.origin), {redirect: "manual"});
    expect(new URL(reopened.headers.get("location")!, first.origin).hash.slice(1)).toBe(first.browserToken);
    expect(reopened.headers.get("set-cookie")).toBeNull();
    const port = Number(new URL(first.origin).port);
    await first.close();
    const restarted = await fixture(undefined, port);
    expect((await restarted.api("/api/sessions", undefined, {"X-Opper-Desktop-Browser": first.browserToken})).status).toBe(401);
    expect((await restarted.api("/api/sessions")).status).toBe(200);
    expect((await second.api("/api/sessions")).status).toBe(200);
  });

  it("uses origin-scoped storage and sends no browser credential to another loopback listener or redirect", async () => {
    const f = await fixture();
    const received: Array<Record<string, string | string[] | undefined>> = [];
    const other = createServer((req, res) => {received.push(req.headers); res.setHeader("Connection", "close"); res.end("{}");});
    other.listen(0, "127.0.0.1"); await once(other, "listening");
    cleanup.push(() => new Promise<void>((resolve) => {other.closeAllConnections(); other.close(() => resolve());}));
    const otherOrigin = `http://127.0.0.1:${(other.address() as {port:number}).port}`;
    const script = await (await fetch(f.origin + "/app.js")).text();
    const browser = runBrowserScript(script, f.origin, f.browserToken);
    expect(browser.location.hash).toBe("");
    expect(browser.replaced()).toBe("/");
    expect(browser.storage.get("opper_desktop_browser")).toBe(f.browserToken);
    expect(await browser.api("/api/sessions")).toMatchObject({sessions: []});
    for (const {url, options} of browser.requests) {
      expect(new URL(url).origin).toBe(f.origin);
      expect(options).toMatchObject({credentials: "omit", redirect: "error", mode: "same-origin"});
      expect(options.headers).toMatchObject({"X-Opper-Desktop-Browser": f.browserToken});
      expect(options.headers).not.toHaveProperty("Cookie");
    }
    // A second page on another port has distinct browser storage and cannot recover the first token.
    const otherPage = runBrowserScript(script, otherOrigin, "");
    await expect(otherPage.api("/api/capture")).rejects.toThrow(/reopened/);
    expect(otherPage.requests).toHaveLength(0);
    await fetch(otherOrigin + "/api/capture", {credentials: "omit"});
    expect(received).toHaveLength(1);
    expect(received[0]!.cookie).toBeUndefined();
    expect(received[0]!["x-opper-desktop-browser"]).toBeUndefined();
    await expect(browser.api(otherOrigin + "/api/capture")).rejects.toThrow(/origin/);
    f.redirectTo(otherOrigin + "/api/capture");
    await expect(browser.api("/api/redirect-test")).rejects.toThrow();
    expect(received).toHaveLength(1);
    const crossOrigin = await f.api("/api/sessions", undefined, {Origin: otherOrigin});
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.headers.get("access-control-allow-origin")).toBeNull();
    // Knowing an old cookie value cannot authenticate: only the explicitly supplied page header works.
    const cookieOnly = await fetch(f.origin + "/api/sessions", {headers: {Cookie: `opper_desktop_browser_${new URL(f.origin).port}=${f.browserToken}`}});
    expect(cookieOnly.status).toBe(401);
    const reload = runBrowserScript(script, f.origin, "", browser.storage);
    expect(await reload.api("/api/sessions")).toMatchObject({sessions: []});
  });
});
