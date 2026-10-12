import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { getSlot, isSlotExpired, type AuthSlot } from "../auth/config.js";
import { opperHome } from "../auth/paths.js";
import { validateProjectUuid } from "../api/resolve.js";
import { OpperError } from "../errors.js";
import { validateTags } from "../util/session-url.js";
import { startDesktopBridge } from "../desktop/bridge.js";
import { openDesktopSessions } from "../desktop/sessions.js";
import { createDesktopDashboard } from "../desktop/dashboard.js";
import { openBrowser } from "../util/open-browser.js";

export interface DesktopStateOptions { stateDir?: string }
export interface DesktopStartOptions extends DesktopStateOptions {
  key: string;
  port?: number;
  tags?: Record<string, string>;
  projectUuid?: string | undefined;
  /** Allows embedded use and tests to stop without signalling the whole process. */
  signal?: AbortSignal;
}
export interface DesktopOpenOptions extends DesktopStateOptions {
  key: string;
  projectUuid?: string | undefined;
  open?: boolean;
}
interface DesktopConnection {
  version: 1;
  url: string;
  token: string;
  keyName: string;
  origin: string;
  projectUuid?: string;
  identityFingerprint: string;
}
export interface DesktopManifest {
  version: 1;
  url: string;
  token: string;
  keyName: string;
  origin: string;
  projectUuid?: string;
  pid: number;
}

function stateDirectory(opts: DesktopStateOptions): string {
  return opts.stateDir ?? join(opperHome(), "desktop-bridge");
}
function error(message: string, hint?: string): OpperError {
  return new OpperError("AGENT_CONFIG_CONFLICT", message, hint);
}
function normalizedOrigin(raw: string): string {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new OpperError("INVALID_ARGUMENT", "The Opper API root must be an HTTP(S) URL without a path, credentials, query or fragment.");
  }
  return url.href.replace(/\/+$/, "");
}
function slotIdentity(slot: AuthSlot): string {
  // Keys lacking owner metadata cannot prove a rotated key has the same owner.
  const hasOwner = slot.orgId !== undefined && slot.user?.email !== undefined;
  return JSON.stringify({
    origin: normalizedOrigin(slot.baseUrl ?? "https://api.opper.ai"),
    orgId: slot.orgId ?? null,
    owner: slot.user?.email ?? null,
    projectId: slot.projectId ?? null,
    projectUuid: slot.projectUuid ?? null,
    source: slot.source ?? null,
    credentialKind: slot.projectUuid || slot.projectId !== undefined ? "project" : slot.orgId !== undefined ? "organization" : "unknown",
    ...(hasOwner ? {} : { apiKey: slot.apiKey }),
  });
}
async function requireSlot(key: string): Promise<AuthSlot> {
  const slot = await getSlot(key);
  if (!slot) throw new OpperError("AUTH_REQUIRED", `No stored API key for slot ${JSON.stringify(key)}.`, "Run `opper login` before starting the desktop bridge.");
  if (isSlotExpired(slot)) throw new OpperError("AUTH_EXPIRED", `Stored API key for slot ${JSON.stringify(key)} has expired.`, "Renew this slot with `opper login`.");
  return slot;
}
async function ensurePrivateDirectory(path: string, create = false): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  let stat;
  try { stat = await lstat(path); } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw error("No desktop bridge state found.", "Start `opper desktop start` first, or choose its --state-dir.");
    throw cause;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())) {
    throw error("Desktop bridge state must be a private directory owned by the current user (mode 0700), without a symlink.");
  }
}

async function readPrivateJson(directory: string, name: string): Promise<unknown | undefined> {
  await ensurePrivateDirectory(directory);
  let file;
  try { file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW); } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error(`Cannot safely read desktop bridge ${name}.`);
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || stat.size > 16_384) {
      throw error(`Desktop bridge ${name} must be a private regular file owned by the current user (mode 0600).`);
    }
    try { return JSON.parse(await file.readFile("utf8")) as unknown; } catch { throw error(`Malformed desktop bridge ${name}.`); }
  } finally { await file.close(); }
}
function validateConnection(value: unknown): DesktopConnection | DesktopManifest {
  if (!value || typeof value !== "object") throw error("Malformed desktop bridge connection.");
  const manifest = value as Partial<DesktopManifest & DesktopConnection>;
  if (manifest.version !== 1 || typeof manifest.url !== "string" ||
      typeof manifest.token !== "string" || !/^[a-f0-9]{64}$/.test(manifest.token) ||
      typeof manifest.keyName !== "string" || typeof manifest.origin !== "string" ||
      (manifest.projectUuid !== undefined && typeof manifest.projectUuid !== "string")) {
    throw error("Malformed desktop bridge connection.");
  }
  let url: URL;
  try { url = new URL(manifest.url); } catch { throw error("Malformed desktop bridge endpoint."); }
  // Fixed IPv4 avoids hostname resolution, localhost rebinding and non-local destinations.
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw error("Desktop bridge endpoint must be an HTTP URL on 127.0.0.1 with an explicit port and no path.");
  }
  normalizedOrigin(manifest.origin);
  if (manifest.projectUuid !== undefined) validateProjectUuid(manifest.projectUuid);
  return manifest as DesktopManifest | DesktopConnection;
}
/** Read secrets only from a private regular file, and never send them to arbitrary URLs. */
export async function readDesktopManifest(opts: DesktopStateOptions): Promise<DesktopManifest> {
  const value = await readPrivateJson(stateDirectory(opts), "bridge.json");
  if (value === undefined) throw error("No running desktop bridge manifest found.", "Start `opper desktop` first.");
  const manifest = validateConnection(value) as DesktopManifest;
  if (!Number.isSafeInteger(manifest.pid) || manifest.pid <= 0) throw error("Malformed desktop bridge manifest.");
  return manifest;
}
async function savedConnection(directory: string): Promise<DesktopConnection | undefined> {
  const value = await readPrivateJson(directory, "connection.json");
  if (value === undefined) return undefined;
  const connection = validateConnection(value) as DesktopConnection;
  if (typeof connection.identityFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(connection.identityFingerprint)) throw error("Malformed desktop bridge connection identity.");
  return connection;
}
async function writePrivateJson(directory: string, name: string, value: unknown): Promise<void> {
  const temporary = join(directory, `.${name}.${process.pid}.${randomBytes(8).toString("hex")}`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.close();
    await rename(temporary, join(directory, name));
  } catch (cause) {
    await file.close(); await unlink(temporary).catch(() => {}); throw cause;
  }
}
export function readDesktopRuntime(stateDir?: string): Promise<DesktopManifest> {
  return readDesktopManifest(stateDir !== undefined ? { stateDir } : {});
}
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function startupCredential(opts: { key: string; projectUuid?: string | undefined }): Promise<{origin: string; identity: string; fingerprint: string; slot: AuthSlot}> {
  if (opts.projectUuid !== undefined) validateProjectUuid(opts.projectUuid);
  if (process.env.OPPER_API_KEY) throw new OpperError("INVALID_ARGUMENT", "Desktop bridge requires a stored credential slot; unset OPPER_API_KEY.");
  const slot = await requireSlot(opts.key);
  const origin = normalizedOrigin(slot.baseUrl ?? "https://api.opper.ai");
  if (process.env.OPPER_BASE_URL && normalizedOrigin(process.env.OPPER_BASE_URL) !== origin) {
    throw new OpperError("INVALID_ARGUMENT", "OPPER_BASE_URL does not match the selected credential slot's API root.");
  }
  const identity = slotIdentity(slot);
  return { origin, identity, fingerprint: createHash("sha256").update(identity).digest("hex"), slot };
}
function validateBinding(connection: DesktopConnection | DesktopManifest, opts: {key: string; projectUuid?: string | undefined}, origin: string, fingerprint?: string): void {
  if (connection.keyName !== opts.key || connection.origin !== origin || connection.projectUuid !== opts.projectUuid ||
      (fingerprint !== undefined && "identityFingerprint" in connection && connection.identityFingerprint !== fingerprint)) {
    throw error("This desktop state belongs to a different credential identity or Opper project.", "Use a separate --state-dir for the new slot, host, owner or project binding.");
  }
}
/** Catalog preparation must obey the same identity binding as bridge forwarding. */
export async function resolveDesktopApiContext(stateDir?: string): Promise<{apiKey: string; baseUrl: string; projectUuid?: string}> {
  const options = stateDir === undefined ? {} : { stateDir };
  const manifest = await readDesktopManifest(options);
  const connection = await savedConnection(stateDirectory(options));
  if (!connection) throw error("No saved desktop credential binding found.");
  const binding = { key: manifest.keyName, ...(manifest.projectUuid ? { projectUuid: manifest.projectUuid } : {}) };
  const { origin, fingerprint, slot } = await startupCredential(binding);
  validateBinding(manifest, binding, origin);
  validateBinding(connection, binding, origin, fingerprint);
  return { apiKey: slot.apiKey, baseUrl: origin, ...(manifest.projectUuid ? { projectUuid: manifest.projectUuid } : {}) };
}
function localJson(res: ServerResponse, code: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
async function controlBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new Error("Control body too large");
    chunks.push(Buffer.from(chunk));
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid control body");
  return value as Record<string, unknown>;
}
function validControlTags(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid control tags");
  const entries = Object.entries(value);
  if (entries.some(([key, val]) => typeof val !== "string" || key.toLowerCase() === "session_id")) throw new Error("Invalid control tags");
  const tags = Object.fromEntries(entries) as Record<string, string>;
  validateTags(tags);
  return tags;
}
export async function desktopStartCommand(opts: DesktopStartOptions): Promise<void> {
  validControlTags(opts.tags ?? {});
  if (opts.port !== undefined && (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535)) {
    throw new OpperError("INVALID_ARGUMENT", "port must be an integer from 0 to 65535");
  }
  const {origin, identity: expectedIdentity, fingerprint} = await startupCredential(opts);
  const directory = stateDirectory(opts);
  await ensurePrivateDirectory(directory, true);
  const path = join(directory, "bridge.json");
  let release;
  try {
    release = await lockfile.lock(directory, { realpath: false, stale: 10_000, update: 2_000, retries: 0 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ELOCKED") throw cause;
    throw error("This desktop bridge state directory is already in use.", "Use `opper desktop status`, or choose a different --state-dir. After a crash, wait ten seconds and retry.");
  }
  let bridge: Awaited<ReturnType<typeof startDesktopBridge>> | undefined;
  let ownManifest: DesktopManifest | undefined;
  let stop: (() => void) | undefined;
  let removeSignals: (() => void) | undefined;
  try {
    try {
      const previous = await readDesktopManifest({ stateDir: directory });
      if (pidAlive(previous.pid)) {
        throw error("A process recorded in this bridge's manifest is still alive.", "Stop that bridge, or use a different --state-dir; active state will not be replaced.");
      }
      await unlink(path);
    } catch (cause) {
      if (!(cause instanceof OpperError && cause.message === "No running desktop bridge manifest found.")) throw cause;
    }
    const stopped = new Promise<void>((resolve) => { stop = resolve; });
    const onStop = () => stop?.();
    process.once("SIGINT", onStop);
    process.once("SIGTERM", onStop);
    opts.signal?.addEventListener("abort", onStop, { once: true });
    removeSignals = () => {
      process.off("SIGINT", onStop); process.off("SIGTERM", onStop);
      opts.signal?.removeEventListener("abort", onStop);
    };
    const connection = await savedConnection(directory);
    if (connection) validateBinding(connection, opts, origin, fingerprint);
    const persistedPort = connection ? Number(new URL(connection.url).port) : undefined;
    if (persistedPort && opts.port && persistedPort !== opts.port) {
      throw error("The requested port differs from this bridge's saved desktop endpoint.", "Reuse its saved port, or use a separate --state-dir for a new endpoint.");
    }
    const token = connection?.token ?? randomBytes(32).toString("hex");
    const sessions = await openDesktopSessions(directory);
    const select = (session: {id: string; tags: Record<string, string>}) => bridge?.setContext({sessionId: session.id, tags: session.tags});
    if (opts.tags && Object.keys(opts.tags).length > 0) {
      await sessions.create("CLI session", opts.tags.project ?? "", opts.tags);
    }
    const selected = sessions.state().sessions.find((session) => session.id === sessions.state().activeId);
    const dashboard = createDesktopDashboard({
      getState: () => ({ ...sessions.state(), activeRequests: bridge?.status().activeRequests ?? 0 }),
      createSession: async (name, project) => { select(await sessions.create(name, project)); },
      activateSession: async (id) => { select(await sessions.activate(id)); },
      pauseSession: async () => { await sessions.clear(); bridge?.pause(); },
    });
    const status = () => ({ ...bridge?.status(), ...sessions.state() });
    const handleLocalRequest = (req: IncomingMessage, res: ServerResponse): boolean => {
      if (dashboard.handle(req, res)) return true;
      const path = req.url ?? "";
      const method = path === "/opper/status" ? "GET" : ["/opper/context", "/opper/activate", "/opper/open", "/opper/stop"].includes(path) ? "POST" : undefined;
      if (!method) return false;
      const given = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        localJson(res, 401, {error: "Invalid local authentication"}); req.resume(); return true;
      }
      if (req.method !== method) { localJson(res, 405, {error: "Unsupported method"}); req.resume(); return true; }
      void (async () => {
        if (path === "/opper/status") { localJson(res, 200, status()); return; }
        if (path === "/opper/open") { localJson(res, 200, {url: dashboard.createLaunchUrl(bridge!.url)}); req.resume(); return; }
        if (path === "/opper/stop") {
          req.resume(); res.once("finish", () => setImmediate(onStop)); localJson(res, 200, {stopped: true}); return;
        }
        const body = await controlBody(req);
        if (path === "/opper/activate") {
          if (typeof body.id !== "string" || Object.keys(body).some((key) => key !== "id")) throw new Error("Invalid session selection");
          select(await sessions.activate(body.id));
        } else {
          if (Object.keys(body).some((key) => key !== "tags")) throw new Error("Invalid context");
          const tags = validControlTags(body.tags);
          if (Object.keys(tags).length === 0) { await sessions.clear(); bridge?.pause(); }
          else select(await sessions.create("CLI session", tags.project ?? "", tags));
        }
        localJson(res, 200, status());
      })().catch(() => localJson(res, 400, {error: "Invalid local control request"}));
      return true;
    };
    bridge = await startDesktopBridge({
      token, origin,
      port: persistedPort ?? opts.port ?? 0,
      initialContext: selected ? { sessionId: selected.id, tags: selected.tags } : null,
      ...(opts.projectUuid !== undefined ? { projectUuid: opts.projectUuid } : {}),
      handleLocalRequest,
      resolveCredential: async () => {
        const current = await requireSlot(opts.key);
        if (slotIdentity(current) !== expectedIdentity) {
          throw new OpperError("AUTH_REQUIRED", "The credential slot's host, owner or binding changed. Restart the desktop bridge for that identity.");
        }
        return current.apiKey;
      },
      onRequest: (event) => {
        console.log(JSON.stringify({ time: new Date().toISOString(), path: event.path, tags: event.tags, sessionId: event.sessionId, status: event.status }));
      },
    });
    // Bind dashboard Host/Origin before its first unauthenticated request can arrive.
    dashboard.createLaunchUrl(bridge.url);
    if (!connection) await writePrivateJson(directory, "connection.json", {
      version: 1, url: bridge.url, token, keyName: opts.key, origin, identityFingerprint: fingerprint,
      ...(opts.projectUuid !== undefined ? { projectUuid: opts.projectUuid } : {}),
    } satisfies DesktopConnection);
    ownManifest = { version: 1, url: bridge.url, token, keyName: opts.key, origin, pid: process.pid,
      ...(opts.projectUuid !== undefined ? { projectUuid: opts.projectUuid } : {}),
    };
    await writePrivateJson(directory, "bridge.json", ownManifest);
    console.log(`Desktop bridge ready at ${bridge.url}`);
    console.log(`Runtime state: ${path}`);
    console.log("Changing tags affects every subsequent request through this bridge. Ctrl-C stops it.");
    if (opts.signal?.aborted) stop?.();
    await stopped;
  } finally {
    removeSignals?.();
    try {
      await bridge?.close();
      if (ownManifest) {
        try {
          const current = await readDesktopManifest({ stateDir: directory });
          if (current.token === ownManifest.token && current.pid === ownManifest.pid && current.url === ownManifest.url) await unlink(path);
        } catch (cause) {
          if (!(cause instanceof OpperError && cause.message === "No running desktop bridge manifest found.")) throw cause;
        }
      }
    } finally { await release(); }
  }
}

async function requestControl(manifest: DesktopManifest, route = "status", body?: unknown): Promise<{ value: unknown; url: string }> {
  let response;
  try {
    response = await fetch(`${manifest.url.replace(/\/+$/, "")}/opper/${route}`, {
      method: route === "status" ? "GET" : "POST",
      headers: { authorization: `Bearer ${manifest.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new OpperError("NETWORK_ERROR", "Cannot reach the desktop bridge.", "Check its foreground process. If it crashed, restart it with the same --state-dir after ten seconds.");
  }
  if (!response.ok) throw new OpperError("API_ERROR", `Desktop bridge control failed (HTTP ${response.status}).`);
  return { value: await response.json(), url: manifest.url };
}
function printStatus(result: { value: unknown; url: string }): void {
  // Only allow known safe fields in output, even if another local service answers.
  const status = result.value as { tags?: unknown; sessionId?: unknown; activeRequests?: unknown; requests?: unknown } | null;
  console.log(JSON.stringify({
    url: result.url,
    tags: status?.tags,
    sessionId: typeof status?.sessionId === "string" ? status.sessionId : undefined,
    activeRequests: typeof status?.activeRequests === "number" ? status.activeRequests : undefined,
    requests: typeof status?.requests === "number" ? status.requests : undefined,
    paused: typeof (status as {paused?: unknown})?.paused === "boolean" ? (status as {paused: boolean}).paused : undefined,
  }, null, 2));
}
export async function desktopStatusCommand(opts: DesktopStateOptions): Promise<void> {
  printStatus(await requestControl(await readDesktopManifest(opts)));
}
export async function desktopTagCommand(opts: DesktopStateOptions & { tags: Record<string, string> }): Promise<void> {
  if (Object.keys(opts.tags).length === 0) throw new OpperError("INVALID_ARGUMENT", "Choose at least one --tag, or use `opper desktop clear`.");
  validControlTags(opts.tags);
  printStatus(await requestControl(await readDesktopManifest(opts), "context", {tags: opts.tags}));
}
export async function desktopClearCommand(opts: DesktopStateOptions): Promise<void> {
  printStatus(await requestControl(await readDesktopManifest(opts), "context", {tags: {}}));
}

export async function desktopStopCommand(opts: DesktopStateOptions): Promise<void> {
  const manifest = await readDesktopManifest(opts);
  await requestControl(manifest, "stop");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    let current: DesktopManifest | undefined;
    try { current = await readDesktopManifest(opts); } catch (cause) {
      if (!(cause instanceof OpperError && cause.message === "No running desktop bridge manifest found.")) throw cause;
    }
    // Another process can legitimately start once the old lifetime lock is released.
    if (current && current.pid !== manifest.pid) {
      console.log("Desktop bridge stopped. Saved sessions and connection settings remain available."); return;
    }
    if (!current) {
      let locked = true;
      try { await lstat(`${stateDirectory(opts)}.lock`); } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") locked = false; else throw cause;
      }
      if (!locked) {
        let reachable = true;
        try { await fetch(`${manifest.url}/opper/status`, {signal: AbortSignal.timeout(250)}); } catch { reachable = false; }
        if (!reachable) {
          console.log("Desktop bridge stopped. Saved sessions and connection settings remain available."); return;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new OpperError("NETWORK_ERROR", "Desktop bridge acknowledged stop but has not finished shutting down.", "Wait for its foreground process to finish before restarting it.");
}

/** Open the local picker, reusing a compatible service or starting a detached CLI process. */
export async function desktopOpenCommand(opts: DesktopOpenOptions): Promise<{ url: string }> {
  const { origin, fingerprint } = await startupCredential(opts);
  const directory = stateDirectory(opts);
  await ensurePrivateDirectory(directory, true);
  const connection = await savedConnection(directory);
  if (connection) validateBinding(connection, opts, origin, fingerprint);
  let manifest: DesktopManifest | undefined;
  try { manifest = await readDesktopManifest({stateDir: directory}); } catch (cause) {
    if (!(cause instanceof OpperError && cause.message === "No running desktop bridge manifest found.")) throw cause;
  }
  if (manifest && pidAlive(manifest.pid)) {
    validateBinding(manifest, opts, origin);
    await requestControl(manifest);
  } else {
    const log = await open(join(directory, "bridge.log"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await log.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw error("Desktop bridge log must be a private regular file owned by the current user (mode 0600).");
      const entry = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../index.ts" : "../index.js", import.meta.url));
      const args = [...process.execArgv, entry, "--key", opts.key,
        ...(opts.projectUuid !== undefined ? ["--project-uuid", opts.projectUuid] : []),
        "desktop", "start", "--state-dir", directory];
      const child = spawn(process.execPath, args, {detached: true, stdio: ["ignore", log.fd, log.fd], env: {...process.env, NO_UPDATE_NOTIFIER: "1"}});
      let spawnFailure: unknown;
      child.once("error", (cause) => { spawnFailure = cause; });
      child.unref();
      manifest = undefined;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (spawnFailure) throw new OpperError("NETWORK_ERROR", "Could not start the desktop bridge process.");
        try {
          const candidate = await readDesktopManifest({stateDir: directory});
          if (pidAlive(candidate.pid)) {
            validateBinding(candidate, opts, origin);
            await requestControl(candidate);
            manifest = candidate; break;
          }
        } catch (cause) {
          if (cause instanceof OpperError && cause.code === "AGENT_CONFIG_CONFLICT" && cause.message !== "No running desktop bridge manifest found.") throw cause;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!manifest) throw new OpperError("NETWORK_ERROR", "Desktop bridge did not become ready within ten seconds.", `Inspect the private log at ${join(directory, "bridge.log")}.`);
    } finally { await log.close(); }
  }
  const result = await requestControl(manifest, "open");
  const launch = result.value as {url?: unknown};
  if (typeof launch?.url !== "string") throw error("Desktop bridge returned an invalid picker URL.");
  const url = new URL(launch.url);
  if (url.origin !== new URL(manifest.url).origin || url.username || url.password) throw error("Desktop picker must stay on the configured loopback endpoint.");
  if (opts.open !== false) openBrowser(url.href);
  // A one-use local browser ticket, never the inference token or an Opper key.
  console.log(`Desktop sessions: ${url.href}`);
  return { url: url.href };
}
