import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WORDMARK } from "./brand.js";
import { CSS } from "./theme.js";

const FONT = readFileSync(new URL("../../data/desktop/inter-latin.woff2", import.meta.url));

export interface DashboardState {
  sessions: Array<{id: string; name: string; project: string; archivedAt?: string}>;
  activeId: string | null;
  activeRequests: number;
}
export interface DashboardDependencies {
  getState(): DashboardState;
  createSession(name: string, project: string): Promise<void>;
  activateSession(id: string): Promise<void>;
  archiveSession(id: string): Promise<void>;
  restoreSession(id: string): Promise<void>;
  pauseSession(): Promise<void>;
}

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opper · Sessions</title><link rel="stylesheet" href="/styles.css"><script src="/app.js" defer></script></head>
<body><main><header><a class="brand" href="/" aria-label="Opper home">${WORDMARK}</a><span class="local">On this computer</span></header>
<div class="intro"><span class="eyebrow">OPPER PROXY</span><h1>Sessions</h1><p>Choose the project for your work in Claude and Codex.</p></div>
<section class="active-card" aria-labelledby="active-heading"><div class="section-label"><span class="signal" id="signal"></span><h2 id="active-heading">Current session</h2></div><h3 id="active-name">Choose a session</h3><p id="active-project">Choose a session before using Claude or Codex.</p><div class="active-bottom"><span id="request-status">Checking sessions…</span><button id="pause" class="quiet" disabled>End session</button></div></section>
<p class="scope">The selected session applies to new inference in both apps. Finish ongoing work before switching.</p>
<div class="columns"><section class="saved" aria-labelledby="saved-heading"><div class="section-top"><h2 id="saved-heading">Saved sessions</h2><span id="session-count"></span></div><div class="session-views" role="group" aria-label="Session view"><button id="saved-view" aria-pressed="true">Saved</button><button id="archived-view" aria-pressed="false">Archived</button></div><div id="sessions" class="session-list"></div><p id="empty">Create a session to get started.</p></section>
<section class="create" aria-labelledby="create-heading"><h2 id="create-heading">New session</h2><p>Give this work a name and project.</p><form id="create-form"><label for="name">Session name</label><input id="name" name="name" placeholder="Website redesign" maxlength="128" required autocomplete="off"><label for="project">Project</label><input id="project" name="project" list="project-options" placeholder="acme" maxlength="256" required autocomplete="off"><datalist id="project-options"></datalist><button class="primary" type="submit">Create and use session <span aria-hidden="true">↗</span></button></form></section></div><p id="feedback" role="status" aria-live="polite"></p><footer>One active session · Your saved sessions stay here</footer></main></body></html>`;

const SCRIPT = `"use strict";
const el = (id) => document.getElementById(id);
let busy = false;
let latest = null;
let view = "saved";
function feedback(message, error = false) {el("feedback").textContent = message; el("feedback").classList.toggle("error", error);}
function render(state) {
  latest = state;
  const active = state.sessions.find((session) => session.id === state.activeId && !session.archivedAt);
  el("active-name").textContent = active ? active.name : "Choose a session";
  el("active-project").textContent = active ? "Project · " + active.project : "Choose a session before using Claude or Codex.";
  el("signal").classList.toggle("on", Boolean(active));
  el("pause").disabled = busy || !active;
  el("request-status").textContent = state.activeRequests > 0 ? state.activeRequests + " request" + (state.activeRequests === 1 ? "" : "s") + " in progress" : active ? "Ready for your next request" : "No active session";
  const saved = state.sessions.filter((session) => !session.archivedAt);
  const archived = state.sessions.filter((session) => session.archivedAt);
  const visible = view === "archived" ? archived : saved;
  el("saved-heading").textContent = view === "archived" ? "Archived sessions" : "Saved sessions";
  el("session-count").textContent = visible.length + " " + view;
  el("saved-view").textContent = "Saved (" + saved.length + ")";
  el("archived-view").textContent = "Archived (" + archived.length + ")";
  el("saved-view").setAttribute("aria-pressed", String(view === "saved"));
  el("archived-view").setAttribute("aria-pressed", String(view === "archived"));
  el("saved-view").disabled = busy; el("archived-view").disabled = busy;
  el("empty").hidden = visible.length > 0;
  el("empty").textContent = view === "archived" ? "No archived sessions. Archived work keeps its usage history and can be restored here." : "Create a session to get started.";
  el("sessions").replaceChildren();
  el("project-options").replaceChildren();
  for (const project of new Set(state.sessions.map((session) => session.project))) {const option = document.createElement("option"); option.value = project; el("project-options").append(option);}
  for (const session of visible) {
    const row = document.createElement("div"); row.className = "session";
    const details = document.createElement("div"); details.className = "session-details";
    const name = document.createElement("div"); name.className = "session-name"; name.textContent = session.name;
    const project = document.createElement("div"); project.className = "session-project"; project.textContent = "Project · " + session.project;
    details.append(name, project); row.append(details);
    const actions = document.createElement("div"); actions.className = "session-actions";
    const path = "/api/sessions/" + encodeURIComponent(session.id);
    if (session.archivedAt) {
      const restore = document.createElement("button"); restore.textContent = "Restore"; restore.disabled = busy;
      restore.addEventListener("click", async () => {if (await mutate(path + "/restore", {}, "Session restored. Use it when you are ready to continue.")) {view = "saved"; render(latest);}}); actions.append(restore);
    } else {
      if (session.id === state.activeId) {row.classList.add("selected"); const label = document.createElement("span"); label.className = "selected-label"; label.textContent = "In use"; actions.append(label);}
      else {const button = document.createElement("button"); button.textContent = "Use session"; button.disabled = busy; button.addEventListener("click", () => mutate(path + "/activate", {}, "Session selected.")); actions.append(button);}
      const archive = document.createElement("button"); archive.className = "quiet session-archive"; archive.textContent = "Archive"; archive.disabled = busy;
      archive.addEventListener("click", () => mutate(path + "/archive", {}, latest.activeId === session.id ? "Session archived and paused. Choose a session before continuing." : "Session archived. Its usage history is kept.")); actions.append(archive);
    }
    row.append(actions);
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
el("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = el("name").value.trim(); const project = el("project").value.trim();
  const encoder = new TextEncoder();
  if (encoder.encode(name).length > 128) {feedback("Session name is too long. Shorten it and try again.", true); el("name").focus(); return;}
  if (encoder.encode(project).length > 256) {feedback("Project is too long. Shorten it and try again.", true); el("project").focus(); return;}
  if (!name || !project) {feedback("Enter a session name and project.", true); return;}
  if (await mutate("/api/sessions", {name, project}, "Session created and selected.")) {el("create-form").reset(); view = "saved"; render(latest);}
});
el("pause").addEventListener("click", () => mutate("/api/pause", {}, "Session ended. Select a session when you are ready to continue."));
el("saved-view").addEventListener("click", () => {view = "saved"; if (latest) render(latest);});
el("archived-view").addEventListener("click", () => {view = "archived"; if (latest) render(latest);});
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
    return {sessions: current.sessions.map(({id, name, project, archivedAt}) => ({id, name, project, ...(archivedAt !== undefined ? {archivedAt} : {})})), activeId: current.activeId, activeRequests: current.activeRequests};
  }
  function json(res: ServerResponse, code: number, value: unknown) {res.writeHead(code, {"Content-Type":"application/json; charset=utf-8"}); res.end(JSON.stringify(value));}
  function authenticated(req: IncomingMessage) {
    const prefix = `${cookieName}=`;
    const token = req.headers.cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith(prefix))?.slice(prefix.length);
    return token !== undefined && /^[a-f0-9]{64}$/.test(token) && timingSafeEqual(Buffer.from(token), Buffer.from(browserToken));
  }
  async function serve(req: IncomingMessage, res: ServerResponse, path: string) {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("X-Frame-Options", "DENY"); res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    if (!allowedOrigin || req.headers.host !== new URL(allowedOrigin).host) throw new DashboardError(403, "This page is available only on this computer.");
    if (path.startsWith("/open/")) {
      if (req.method !== "GET") throw new DashboardError(405, "Method not allowed.");
      const ticket = path.slice("/open/".length); const expires = tickets.get(ticket); tickets.delete(ticket);
      if (!expires || expires <= Date.now()) throw new DashboardError(401, "Reopen this page from Opper.");
      res.writeHead(303, {Location:"/", "Set-Cookie":`${cookieName}=${browserToken}; Path=/api; HttpOnly; SameSite=Strict`}); res.end(); return;
    }
    if (["/", "/app.js", "/styles.css", "/inter-latin.woff2"].includes(path)) {
      if (req.method !== "GET") throw new DashboardError(405, "Method not allowed.");
      res.writeHead(200, {"Content-Type": path === "/" ? "text/html; charset=utf-8" : path === "/app.js" ? "text/javascript; charset=utf-8" : path === "/styles.css" ? "text/css; charset=utf-8" : "font/woff2"});
      res.end(path === "/" ? HTML : path === "/app.js" ? SCRIPT : path === "/styles.css" ? CSS : FONT); return;
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
        if (typeof name !== "string" || !name.trim() || typeof project !== "string" || !project.trim()) throw new DashboardError(400, "Enter a session name and project.");
        if (Buffer.byteLength(name.trim(), "utf8") > 128) throw new DashboardError(400, "Session name is too long. Shorten it and try again.");
        if (Buffer.byteLength(project.trim(), "utf8") > 256) throw new DashboardError(400, "Project is too long. Shorten it and try again.");
        await deps.createSession(name.trim(), project.trim());
      } else if (path === "/api/pause") await deps.pauseSession();
      else {
        const match = /^\/api\/sessions\/([a-zA-Z0-9_-]+)\/(activate|archive|restore)$/.exec(path);
        const id = match?.[1]; if (!id) throw new DashboardError(404, "Session not found.");
        if (match![2] === "archive") await deps.archiveSession(id);
        else if (match![2] === "restore") await deps.restoreSession(id);
        else await deps.activateSession(id);
      }
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
      if (!["/", "/app.js", "/styles.css", "/inter-latin.woff2", "/api/sessions", "/api/pause"].includes(path) && !path.startsWith("/open/") && !/^\/api\/sessions\/[^/]+\/(activate|archive|restore)$/.test(path)) return false;
      void serve(req, res, path).catch((error: unknown) => {if (!res.headersSent) json(res, error instanceof DashboardError ? error.code : 500, {error: error instanceof DashboardError ? error.message : "Could not load sessions. Try again."}); else res.end();});
      return true;
    },
  };
}
