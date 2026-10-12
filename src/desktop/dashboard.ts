import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface DashboardState {
  sessions: Array<{id: string; name: string; project: string}>;
  activeId: string | null;
  activeRequests: number;
}
export interface DashboardDependencies {
  getState(): DashboardState;
  createSession(name: string, project: string): Promise<void>;
  activateSession(id: string): Promise<void>;
  pauseSession(): Promise<void>;
}

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opper · Desktop sessions</title><link rel="stylesheet" href="/styles.css"><script src="/app.js" defer></script></head>
<body><main><header><a class="brand" href="/" aria-label="Opper home">opper<span class="brand-dot">●</span></a><span class="local">On this computer</span></header>
<div class="intro"><span class="eyebrow">YOUR WORK, CORRECTLY ATTRIBUTED</span><h1>Desktop sessions</h1><p>Choose the project for your work in Claude and Codex.</p></div>
<section class="active-card" aria-labelledby="active-heading"><div class="section-label"><span class="signal" id="signal"></span><h2 id="active-heading">Current session</h2></div><h3 id="active-name">Choose a session</h3><p id="active-project">Choose a session before using Claude or Codex.</p><div class="active-bottom"><span id="request-status">Checking sessions…</span><button id="pause" class="quiet" disabled>End session</button></div></section>
<p class="scope">The selected session applies to new inference in both apps. Finish ongoing work before switching.</p>
<div class="columns"><section class="saved" aria-labelledby="saved-heading"><div class="section-top"><h2 id="saved-heading">Saved sessions</h2><span id="session-count"></span></div><div id="sessions" class="session-list"></div><p id="empty">Create a session to get started.</p></section>
<section class="create" aria-labelledby="create-heading"><h2 id="create-heading">New session</h2><p>Give this work a name and project.</p><form id="create-form"><label for="name">Session name</label><input id="name" name="name" placeholder="Website redesign" maxlength="120" required autocomplete="off"><label for="project">Project</label><input id="project" name="project" list="project-options" placeholder="acme" maxlength="256" required autocomplete="off"><datalist id="project-options"></datalist><button class="primary" type="submit">Create and use session <span aria-hidden="true">↗</span></button></form></section></div><p id="feedback" role="status" aria-live="polite"></p><footer>One active session · Your saved sessions stay here</footer></main></body></html>`;

const CSS = `:root{color-scheme:light;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#202326;background:#f6f7f8;font-synthesis:none}*{box-sizing:border-box}body{margin:0}main{max-width:1020px;margin:auto;padding:32px 36px}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:55px}.brand{font-size:30px;font-weight:700;letter-spacing:-1.7px;color:#1d232b;text-decoration:none}.brand-dot{font-size:12px;margin-left:4px;color:#735cff}.local{font-size:12px;color:#717780;border:1px solid #dfe2e7;border-radius:20px;padding:7px 11px}.eyebrow{font-size:10px;font-weight:650;letter-spacing:1.7px;color:#707885}h1{font-size:38px;letter-spacing:-1.3px;margin:12px 0 10px;line-height:1.15}.intro>p{color:#747b86;font-size:15px;margin:0 0 28px}.active-card{background:#1c222c;color:#f5f7fc;border-radius:14px;padding:25px 28px;box-shadow:0 8px 30px #101b3010}.section-label{display:flex;align-items:center;gap:9px}.section-label h2{font-size:12px;color:#c1c6d2;margin:0;font-weight:500}.signal{width:7px;height:7px;border-radius:50%;background:#798396}.signal.on{background:#a6edb6;box-shadow:0 0 0 4px #a6edb612}.active-card h3{font-size:24px;margin:19px 0 7px;font-weight:550;letter-spacing:-.5px}.active-card>p{color:#aeb8c9;font-size:13px;margin:0}.active-bottom{display:flex;align-items:center;justify-content:space-between;margin-top:22px;border-top:1px solid #3c4451;padding-top:17px}.active-bottom>span{font-size:12px;color:#aeb8c9}button{font:inherit;cursor:pointer;border-radius:7px;border:1px solid #dce0e6;background:#fff;padding:9px 12px;font-size:12px;color:#2d3542;font-weight:550;transition:background .15s}button:hover{background:#f1f2f6}button:focus-visible,a:focus-visible,input:focus-visible{outline:3px solid #a99cff;outline-offset:3px}button:disabled{cursor:default;opacity:.45}.quiet{color:#dae1eb;background:transparent;border-color:#515c6d;padding:7px 11px}.quiet:hover{background:#333c4b}.scope{font-size:12px;color:#757e8d;margin:14px 2px 31px;line-height:1.6}.columns{display:grid;grid-template-columns:1.35fr 1fr;gap:30px}h2{font-size:15px;font-weight:600;letter-spacing:-.2px;margin:0}.section-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:17px}.section-top>span{font-size:11px;color:#8b929c}.session-list{display:flex;flex-direction:column;gap:8px}.session{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:15px 16px;background:#fff;border:1px solid #e3e6eb;border-radius:9px}.session.selected{border-color:#b6a7fa;background:#faf9ff}.session-details{min-width:0}.session-name{font-size:13px;font-weight:550;overflow-wrap:anywhere}.session-project{font-size:11px;color:#828a98;margin-top:5px;overflow-wrap:anywhere}.selected-label{font-size:11px;color:#7353d9;white-space:nowrap}#empty{font-size:13px;color:#89919b;padding:23px 0}.create{padding:20px 23px;background:#fff;border:1px solid #e3e6eb;border-radius:10px;align-self:start}.create>p{font-size:12px;color:#828a98;margin:8px 0 22px}form{display:flex;flex-direction:column}label{font-size:11px;font-weight:550;color:#5c6573;margin-bottom:7px}input{background:#fbfcfd;color:#273142;border:1px solid #dce1e8;border-radius:6px;padding:11px 12px;font:inherit;font-size:13px;margin-bottom:17px;min-width:0}input::placeholder{color:#a0a7b3}.primary{display:flex;align-items:center;justify-content:space-between;background:#7254de;color:#fff;border-color:#7254de;padding:11px 13px;margin-top:3px}.primary:hover{background:#6342cc}#feedback{font-size:12px;color:#7353d9;min-height:18px;margin:23px 0 12px}#feedback.error{color:#a63143}footer{border-top:1px solid #e2e5ea;padding-top:18px;font-size:11px;color:#9299a3;margin-top:8px}@media(max-width:680px){main{padding:24px 20px}header{margin-bottom:38px}.columns{grid-template-columns:1fr;gap:24px}h1{font-size:32px}.active-card{padding:22px}.scope{margin-bottom:26px}}`;

const SCRIPT = `"use strict";
const el = (id) => document.getElementById(id);
let busy = false;
let latest = null;
function feedback(message, error = false) {el("feedback").textContent = message; el("feedback").classList.toggle("error", error);}
function render(state) {
  latest = state;
  const active = state.sessions.find((session) => session.id === state.activeId);
  el("active-name").textContent = active ? active.name : "Choose a session";
  el("active-project").textContent = active ? "Project · " + active.project : "Choose a session before using Claude or Codex.";
  el("signal").classList.toggle("on", Boolean(active));
  el("pause").disabled = busy || !active;
  el("request-status").textContent = state.activeRequests > 0 ? state.activeRequests + " request" + (state.activeRequests === 1 ? "" : "s") + " in progress" : active ? "Ready for your next request" : "No active session";
  el("session-count").textContent = state.sessions.length + " saved";
  el("empty").hidden = state.sessions.length > 0;
  el("sessions").replaceChildren();
  el("project-options").replaceChildren();
  for (const project of new Set(state.sessions.map((session) => session.project))) {const option = document.createElement("option"); option.value = project; el("project-options").append(option);}
  for (const session of state.sessions) {
    const row = document.createElement("div"); row.className = "session";
    const details = document.createElement("div"); details.className = "session-details";
    const name = document.createElement("div"); name.className = "session-name"; name.textContent = session.name;
    const project = document.createElement("div"); project.className = "session-project"; project.textContent = "Project · " + session.project;
    details.append(name, project); row.append(details);
    if (session.id === state.activeId) {row.classList.add("selected"); const label = document.createElement("span"); label.className = "selected-label"; label.textContent = "In use"; row.append(label);}
    else {const button = document.createElement("button"); button.textContent = "Use session"; button.disabled = busy; button.addEventListener("click", () => mutate("/api/sessions/" + encodeURIComponent(session.id) + "/activate", {}, "Session selected.")); row.append(button);}
    el("sessions").append(row);
  }
  el("create-form").querySelector("button").disabled = busy;
}
async function api(path, payload) {
  const response = await fetch(path, payload === undefined ? {cache:"no-store"} : {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload)});
  if (response.status === 401) throw new Error("This page needs to be reopened from Opper.");
  if (!response.ok) {let message = "Could not update sessions. Try again."; try {message = (await response.json()).error || message;} catch {} throw new Error(message);}
  return response.json();
}
async function refresh() {if (busy) return; try {render(await api("/api/sessions"));} catch (error) {feedback(error.message, true);}}
async function mutate(path, payload, message) {
  if (busy) return false; busy = true; if (latest) render(latest);
  try {render(await api(path, payload)); feedback(message); return true;} catch (error) {feedback(error.message, true); return false;} finally {busy = false; if (latest) render(latest);}
}
el("create-form").addEventListener("submit", async (event) => {event.preventDefault(); if (await mutate("/api/sessions", {name:el("name").value.trim(), project:el("project").value.trim()}, "Session created and selected.")) el("create-form").reset();});
el("pause").addEventListener("click", () => mutate("/api/pause", {}, "Session ended. Select a session when you are ready to continue."));
refresh(); setInterval(refresh, 2000);
`;

class DashboardError extends Error { constructor(readonly code: number, message: string) {super(message);} }
function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0; let exceeded = false;
    req.on("data", (chunk: Buffer) => {size += chunk.length; if (size > 8192) {if (!exceeded) {exceeded = true; chunks.length = 0; reject(new DashboardError(413, "Session details are too large."));} return;} chunks.push(Buffer.from(chunk));});
    req.on("end", () => {if (exceeded) return; try {const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); resolve(value as Record<string, unknown>);} catch {reject(new DashboardError(400, "Enter valid session details."));}});
    req.on("error", () => reject(new DashboardError(400, "Could not read session details.")));
  });
}

/** Browser credentials are independent of inference credentials and never embedded in page assets. */
export function createDesktopDashboard(deps: DashboardDependencies) {
  const browserToken = randomBytes(32).toString("hex");
  const tickets = new Map<string, number>();
  let allowedOrigin: string | undefined;
  let cookieName: string | undefined;
  let mutations: Promise<void> = Promise.resolve();
  function state(): DashboardState {
    const current = deps.getState();
    return {sessions: current.sessions.map(({id, name, project}) => ({id, name, project})), activeId: current.activeId, activeRequests: current.activeRequests};
  }
  function json(res: ServerResponse, code: number, value: unknown) {res.writeHead(code, {"Content-Type":"application/json; charset=utf-8"}); res.end(JSON.stringify(value));}
  function authenticated(req: IncomingMessage) {
    const prefix = `${cookieName}=`;
    const token = req.headers.cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith(prefix))?.slice(prefix.length);
    return token !== undefined && /^[a-f0-9]{64}$/.test(token) && timingSafeEqual(Buffer.from(token), Buffer.from(browserToken));
  }
  async function serve(req: IncomingMessage, res: ServerResponse, path: string) {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("X-Frame-Options", "DENY"); res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    if (!allowedOrigin || req.headers.host !== new URL(allowedOrigin).host) throw new DashboardError(403, "This page is available only on this computer.");
    if (path.startsWith("/open/")) {
      if (req.method !== "GET") throw new DashboardError(405, "Method not allowed.");
      const ticket = path.slice("/open/".length); const expires = tickets.get(ticket); tickets.delete(ticket);
      if (!expires || expires <= Date.now()) throw new DashboardError(401, "Reopen this page from Opper.");
      res.writeHead(303, {Location:"/", "Set-Cookie":`${cookieName}=${browserToken}; Path=/api; HttpOnly; SameSite=Strict`}); res.end(); return;
    }
    if (["/", "/app.js", "/styles.css"].includes(path)) {
      if (req.method !== "GET") throw new DashboardError(405, "Method not allowed.");
      res.writeHead(200, {"Content-Type": path === "/" ? "text/html; charset=utf-8" : path === "/app.js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8"});
      res.end(path === "/" ? HTML : path === "/app.js" ? SCRIPT : CSS); return;
    }
    if (!authenticated(req)) throw new DashboardError(401, "Reopen this page from Opper.");
    if (req.method === "GET" && path === "/api/sessions") {json(res, 200, state()); return;}
    if (req.method !== "POST") throw new DashboardError(405, "Method not allowed.");
    if (req.headers.origin !== allowedOrigin) throw new DashboardError(403, "This action must come from the session page.");
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) throw new DashboardError(415, "Send session details as JSON.");
    const payload = await readJson(req);
    const change = async () => {
      if (path === "/api/sessions") {
        const {name, project} = payload;
        if (typeof name !== "string" || !name.trim() || name.trim().length > 120 || typeof project !== "string" || !project.trim() || project.trim().length > 256) throw new DashboardError(400, "Enter a session name and project.");
        await deps.createSession(name.trim(), project.trim());
      } else if (path === "/api/pause") await deps.pauseSession();
      else {const id = /^\/api\/sessions\/([a-zA-Z0-9_-]+)\/activate$/.exec(path)?.[1]; if (!id) throw new DashboardError(404, "Session not found."); await deps.activateSession(id);}
    };
    const pending = mutations.then(change); mutations = pending.catch(() => {});
    try {await pending;} catch (error) {if (error instanceof DashboardError) throw error; throw new DashboardError(400, "Could not update this session. Check its details and try again.");}
    json(res, 200, state());
  }
  return {
    createLaunchUrl(origin: string): string {
      const url = new URL(origin);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || (allowedOrigin && url.origin !== allowedOrigin)) throw new Error("Dashboard origin must be this server's 127.0.0.1 HTTP origin.");
      allowedOrigin = url.origin;
      // Browser cookies are scoped by host/path, not port. Keep parallel local bridges independent.
      cookieName = `opper_desktop_browser_${url.port || "80"}`;
      for (const [ticket, expires] of tickets) if (expires <= Date.now()) tickets.delete(ticket);
      const ticket = randomBytes(24).toString("hex"); tickets.set(ticket, Date.now() + 60_000);
      return `${allowedOrigin}/open/${ticket}`;
    },
    handle(req: IncomingMessage, res: ServerResponse): boolean {
      const path = (req.url ?? "/").split("?")[0]!;
      if (!["/", "/app.js", "/styles.css", "/api/sessions", "/api/pause"].includes(path) && !path.startsWith("/open/") && !/^\/api\/sessions\/[^/]+\/activate$/.test(path)) return false;
      void serve(req, res, path).catch((error: unknown) => {if (!res.headersSent) json(res, error instanceof DashboardError ? error.code : 500, {error: error instanceof DashboardError ? error.message : "Could not load sessions. Try again."}); else res.end();});
      return true;
    },
  };
}
