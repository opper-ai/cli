import { timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { buildSessionBaseUrl, newSessionId, validateTags } from "../util/session-url.js";
import { DESKTOP_SESSION_ID } from "./sessions.js";

export interface DesktopContext {
  sessionId: string;
  tags: Record<string, string>;
}
export interface DesktopRequestEvent extends DesktopContext {
  requestId: string;
  path: string;
  status: number;
}
export interface DesktopBridgeOptions {
  port?: number;
  token: string;
  origin: string;
  initialTags?: Record<string, string>;
  /** null requires an explicit session selection before inference. */
  initialContext?: DesktopContext | null;
  projectUuid?: string;
  resolveCredential: () => Promise<string>;
  onRequest?: (event: DesktopRequestEvent) => void;
  /** Local UI handlers authenticate their own routes. Return false to use normal bearer routing. */
  handleLocalRequest?: (req: IncomingMessage, res: ServerResponse) => boolean;
}
export interface DesktopBridge {
  url: string;
  setTags: (tags: Record<string, string>) => DesktopContext;
  setContext: (context: DesktopContext) => DesktopContext;
  pause: () => void;
  status: () => DesktopContext & { activeRequests: number; requests: number; paused: boolean };
  close: () => Promise<void>;
}

const INFERENCE_PATHS = new Set(["/v3/compat/responses", "/v3/compat/v1/messages", "/v3/compat/chat/completions"]);
const MODEL_PATHS = new Set(["/v3/compat/models", "/v3/compat/v1/models"]);
const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const CLIENT_HEADERS = new Set(["host", "authorization", "x-api-key", "x-opper-tags", "x-opper-project", "x-opper-trace-id"]);

function copyTags(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tags must be an object of string values");
  const entries = Object.entries(value);
  if (entries.some(([key, val]) => typeof val !== "string" || key.toLowerCase() === "session_id")) {
    throw new Error("tags must contain string values and cannot include session_id");
  }
  const tags = Object.fromEntries(entries) as Record<string, string>;
  validateTags(tags);
  return tags;
}

function copyHeaders(headers: IncomingHttpHeaders, request: boolean): OutgoingHttpHeaders {
  const blocked = new Set(HOP_HEADERS);
  for (const name of (headers.connection ?? "").split(",")) blocked.add(name.trim().toLowerCase());
  if (request) for (const name of CLIENT_HEADERS) blocked.add(name);
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => value !== undefined && !blocked.has(name.toLowerCase())));
}

function json(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {"Content-Type": "application/json", "Cache-Control": "no-store"});
  res.end(JSON.stringify(value));
}

function authorized(req: IncomingMessage, token: string) {
  const given = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readContext(req: IncomingMessage): Promise<Record<string, string>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("context request is too large");
    chunks.push(Buffer.from(chunk));
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "tags")) {
    throw new Error("context must contain only tags");
  }
  return copyTags((value as {tags?: unknown}).tags);
}

/** A loopback HTTP bridge. Attribution is snapshotted when each request arrives. */
export async function startDesktopBridge(opts: DesktopBridgeOptions): Promise<DesktopBridge> {
  const port = opts.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be an integer from 0 to 65535");
  if (!opts.token.trim() || /[\r\n]/.test(opts.token)) throw new Error("a nonempty local token is required");
  const origin = new URL(opts.origin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("origin must be an HTTP(S) origin without a path or credentials");
  }
  if (opts.projectUuid && /[\r\n]/.test(opts.projectUuid)) throw new Error("invalid project UUID");
  function copyContext(selected: DesktopContext): DesktopContext {
    if (!selected || typeof selected.sessionId !== "string" || !DESKTOP_SESSION_ID.test(selected.sessionId)) throw new Error("invalid desktop session ID");
    return {sessionId: selected.sessionId, tags: copyTags(selected.tags)};
  }
  let context: DesktopContext = opts.initialContext ? copyContext(opts.initialContext) : { sessionId: newSessionId(), tags: copyTags(opts.initialTags ?? {}) };
  let paused = opts.initialContext === null;
  let activeRequests = 0;
  let requests = 0;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const upstreams = new Set<ClientRequest>();
  const snapshot = (): DesktopContext => ({sessionId: context.sessionId, tags: {...context.tags}});
  const setTags = (tags: Record<string, string>) => {
    context = {sessionId: newSessionId(), tags: copyTags(tags)};
    paused = false;
    return snapshot();
  };
  const setContext = (selected: DesktopContext) => {
    context = copyContext(selected);
    paused = false;
    return snapshot();
  };
  const status = () => ({...snapshot(), activeRequests, requests, paused});
  const server = createServer((req, res) => {
    try {if (opts.handleLocalRequest?.(req, res)) return;}
    catch {json(res, 500, {error: "local request handler failed"}); req.resume(); return;}
    if (!authorized(req, opts.token)) { json(res, 401, {error: "invalid local authentication"}); req.resume(); return; }
    // No URL resolution of a client-supplied path: only these exact routes can reach upstream.
    const path = req.url ?? "";
    const controlMethod = path === "/opper/status" ? "GET" : path === "/opper/context" ? "POST" : undefined;
    const inference = INFERENCE_PATHS.has(path);
    const models = MODEL_PATHS.has(path);
    const method = controlMethod ?? (inference ? "POST" : models ? "GET" : undefined);
    if (!method) {json(res, 404, {error: "unsupported bridge route"}); req.resume(); return;}
    if (req.method !== method) {json(res, 405, {error: "unsupported method"}); req.resume(); return;}
    if (path === "/opper/status") {json(res, 200, status()); return;}
    if (path === "/opper/context") {
      void readContext(req).then((tags) => json(res, 200, setTags(tags))).catch(() => json(res, 400, {error: "invalid context tags"}));
      return;
    }
    if (inference && paused) {json(res, 409, {error: "select an active attribution session before inference"}); req.resume(); return;}
    const selected = snapshot();
    const requestId = `desktop_${++requests}`;
    activeRequests++;
    let upstream: ClientRequest | undefined;
    let completed = false;
    const finish = (outcome = res.statusCode) => {
      if (completed) return;
      completed = true;
      activeRequests--;
      if (upstream) upstreams.delete(upstream);
      try {opts.onRequest?.({...selected, tags: {...selected.tags}, requestId, path, status: outcome});} catch { /* Observability cannot interrupt inference. */ }
    };
    res.once("finish", finish);
    res.once("close", () => { upstream?.destroy(); finish(res.writableFinished ? res.statusCode : 499); });
    req.once("aborted", () => {upstream?.destroy(); res.destroy();});
    req.once("error", () => {upstream?.destroy(); res.destroy();});
    void (async () => {
      const credential = await opts.resolveCredential();
      if (closed || res.destroyed || req.aborted) { finish(); return; }
      if (!credential.trim()) throw new Error("missing credential");
      const target = new URL(inference
        ? `${buildSessionBaseUrl(origin.origin, selected.sessionId, selected.tags)}${path.slice("/v3/compat".length)}`
        : `${origin.origin}${path}`);
      const headers = copyHeaders(req.headers, true);
      headers.authorization = `Bearer ${credential}`;
      if (opts.projectUuid) headers["x-opper-project"] = opts.projectUuid;
      upstream = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {method, headers}, (provider) => {
        const providerStatus = provider.statusCode ?? 502;
        if (providerStatus >= 300 && providerStatus < 400) {
          provider.destroy();
          json(res, 502, {error: "upstream redirects are unsupported"});
          return;
        }
        res.writeHead(providerStatus, copyHeaders(provider.headers, false));
        provider.once("error", () => res.destroy());
        provider.pipe(res);
      });
      upstreams.add(upstream);
      upstream.once("error", () => {
        if (res.headersSent) res.destroy();
        else json(res, 502, {error: "upstream request failed"});
      });
      req.pipe(upstream);
    })().catch(() => json(res, 502, {error: "upstream authentication or request failed"}));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {server.off("error", reject); resolve();});
  });
  const address = server.address() as {port: number};
  return {
    url: `http://127.0.0.1:${address.port}`,
    setTags,
    setContext,
    pause: () => {paused = true;},
    status,
    close() {
      if (!closePromise) {
        closed = true;
        closePromise = new Promise<void>((resolve, reject) => {
          server.close((err) => err ? reject(err) : resolve());
          for (const upstream of upstreams) upstream.destroy();
          server.closeAllConnections();
        });
      }
      return closePromise;
    },
  };
}
