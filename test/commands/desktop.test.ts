import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { desktopStartCommand, desktopTagCommand, desktopClearCommand, desktopStatusCommand, desktopOpenCommand, desktopStopCommand, readDesktopRuntime, resolveDesktopApiContext, prepareDesktopProxy } from "../../src/commands/desktop.js";
import { setSlot, type AuthSlot } from "../../src/auth/config.js";
import { ensurePrivateStateDirectory, assertPrivateStateFile } from "../../src/desktop/private-state.js";

let directory: string;
let stateDir: string;
let origin: string;
let upstream: Server;
let run: Promise<void> | undefined;
let stopper: AbortController;
let requests: Array<{ url: string; key: string | undefined }>;
const slot: AuthSlot = { apiKey: "first-secret", orgId: 42, user: { email: "owner@example.test", name: "Owner" }, source: "device-flow" };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "opper-desktop-command-"));
  stateDir = join(directory, "bridge");
  vi.stubEnv("OPPER_HOME", join(directory, "auth"));
  vi.stubEnv("OPPER_API_KEY", ""); vi.stubEnv("OPPER_BASE_URL", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  requests = [];
  upstream = createServer((req, res) => {
    requests.push({ url: req.url ?? "", key: req.headers.authorization });
    req.resume(); res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Expected listening server");
  origin = `http://127.0.0.1:${address.port}`;
  await setSlot("work", { ...slot, baseUrl: origin });
  stopper = new AbortController();
  run = undefined;
});
afterEach(async () => {
  stopper.abort(); await run;
  try {
    const manifest = await readDesktopRuntime(stateDir);
    if (manifest.pid !== process.pid) {
      await desktopStopCommand({stateDir});
      for (let attempt = 0; attempt < 200; attempt++) {
        try { await readDesktopRuntime(stateDir); } catch { break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  } catch { /* Service may already have stopped. */ }
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
async function start(tags: Record<string, string> = { project: "acme" }) {
  run = desktopStartCommand({ key: "work", stateDir, port: 0, tags, signal: stopper.signal });
  // Observe startup failures immediately as well as making manifest readiness bounded.
  let failure: unknown;
  void run.catch((cause) => { failure = cause; });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (failure) throw failure;
    try {
      const manifest = await readDesktopRuntime(stateDir);
      if (manifest.pid === process.pid) return manifest;
    } catch { /* Startup can be between replacing its stale manifest and publishing readiness. */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Bridge did not become ready");
}
async function inference(url: string, token: string) {
  return fetch(`${url}/v3/compat/responses`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "test/model", input: "dummy test" }) });
}

async function privateDirectory(path: string) {
  if (process.platform === "win32") await ensurePrivateStateDirectory(path);
  else expect((await lstat(path)).mode & 0o777).toBe(0o700);
}
async function privateFile(path: string) {
  if (process.platform === "win32") await assertPrivateStateFile(path);
  else expect((await lstat(path)).mode & 0o777).toBe(0o600);
}
describe("desktop command lifecycle", {timeout: process.platform === "win32" ? 120_000 : 5_000, hookTimeout: process.platform === "win32" ? 60_000 : 10_000}, () => {
  it("prepares a reusable loopback route for launching without exposing the inference token", async () => {
    const manifest = await start();
    const prepared = await prepareDesktopProxy({ key: "work", stateDir });
    expect(prepared.proxy).toEqual({ baseUrl: manifest.url, token: manifest.token, stateDir });
    expect(await resolveDesktopApiContext(stateDir)).toEqual({ apiKey: slot.apiKey, baseUrl: origin });
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).not.toContain(manifest.token);
  });
  it("pins catalog preparation to the bridge host and owner while allowing same-owner renewal", async () => {
    await start();
    expect(await resolveDesktopApiContext(stateDir)).toEqual({ apiKey: slot.apiKey, baseUrl: origin });
    await setSlot("work", { ...slot, apiKey: "renewed-secret", baseUrl: origin });
    expect(await resolveDesktopApiContext(stateDir)).toEqual({ apiKey: "renewed-secret", baseUrl: origin });
    await setSlot("work", { ...slot, apiKey: "other-host-secret", baseUrl: "https://other.example.test" });
    await expect(resolveDesktopApiContext(stateDir)).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    await setSlot("work", { ...slot, baseUrl: origin, user: { email: "other@example.test", name: "Other" } });
    await expect(resolveDesktopApiContext(stateDir)).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    await setSlot("work", { ...slot, baseUrl: origin, expiresAt: "2000-01-01T00:00:00Z" });
    await expect(resolveDesktopApiContext(stateDir)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(requests).toHaveLength(0);
  });
  it("creates private runtime state, switches attribution through real controls, clears and stops", async () => {
    const manifest = await start();
    await privateDirectory(stateDir);
    await privateFile(join(stateDir, "bridge.json"));
    expect(manifest.pid).toBe(process.pid);
    expect((await inference(manifest.url, manifest.token)).status).toBe(200);
    const before = await fetch(`${manifest.url}/opper/status`, {headers: {authorization: `Bearer ${manifest.token}`}}).then((res) => res.json());
    await desktopTagCommand({ stateDir, tags: { project: "beta" } });
    expect((await inference(manifest.url, manifest.token)).status).toBe(200);
    await desktopClearCommand({ stateDir });
    expect((await inference(manifest.url, manifest.token)).status).toBe(409);
    expect(requests).toHaveLength(2);
    const activated = await fetch(`${manifest.url}/opper/activate`, {method: "POST", headers: {authorization: `Bearer ${manifest.token}`, "content-type": "application/json"}, body: JSON.stringify({id: before.activeId})});
    expect(activated.status).toBe(200);
    expect((await inference(manifest.url, manifest.token)).status).toBe(200);
    await desktopStatusCommand({ stateDir });
    expect(requests.map((entry) => entry.url)).toEqual([
      expect.stringMatching(/\/v3\/session\/sess_[^/]+\/project:acme\/responses$/),
      expect.stringMatching(/\/v3\/session\/sess_[^/]+\/project:beta\/responses$/),
      expect.stringMatching(/\/v3\/session\/sess_[^/]+\/project:acme\/responses$/),
    ]);
    expect(new Set(requests.map((entry) => entry.url.split("/")[3])).size).toBe(2);
    expect(requests[0]?.url).toBe(requests[2]?.url);
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).not.toContain(manifest.token); expect(output).not.toContain(slot.apiKey);
    expect(output).toContain(`"url": "${manifest.url}"`);
    expect(output).toContain('"requests": 3');
    stopper.abort(); await run;
    await expect(readFile(join(stateDir, "bridge.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fetch(`${manifest.url}/opper/status`)).rejects.toThrow();
  });
  it("preserves the endpoint, local token, saved sessions and active ID across service restart", async () => {
    const first = await start();
    const initial = await fetch(`${first.url}/opper/status`, {headers: {authorization: `Bearer ${first.token}`}}).then((res) => res.json());
    stopper.abort(); await run;
    stopper = new AbortController();
    const second = await start({});
    expect(second.url).toBe(first.url);
    expect(second.token).toBe(first.token);
    const restarted = await fetch(`${second.url}/opper/status`, {headers: {authorization: `Bearer ${second.token}`}}).then((res) => res.json());
    expect(restarted.activeId).toBe(initial.activeId);
    expect(restarted.sessions).toEqual(initial.sessions);
    const saved = await readFile(join(stateDir, "connection.json"), "utf8");
    expect(saved).not.toContain(slot.apiKey);
    await privateFile(join(stateDir, "connection.json"));
    expect((await inference(second.url, second.token)).status).toBe(200);
  });
  it("opens the actual dashboard and connects its mutations to saved attribution sessions", async () => {
    const manifest = await start({});
    expect((await inference(manifest.url, manifest.token)).status).toBe(409);
    const opened = await desktopOpenCommand({key: "work", stateDir, open: false});
    expect(opened.url).toContain(`${manifest.url}/open/`);
    expect(opened.url).not.toContain(manifest.token);
    const bootstrap = await fetch(opened.url, {redirect: "manual"});
    expect(bootstrap.status).toBe(303);
    expect((await fetch(opened.url, {redirect: "manual"})).status).toBe(401);
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
    const page = await fetch(`${manifest.url}/`);
    expect(await page.text()).toContain("Sessions");
    const created = await fetch(`${manifest.url}/api/sessions`, {method: "POST", headers: {cookie, origin: manifest.url, "content-type": "application/json"}, body: JSON.stringify({name: "Website work", project: "acme"})});
    expect(created.status).toBe(200);
    const state = await created.json();
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].name).toBe("Website work");
    expect((await inference(manifest.url, manifest.token)).status).toBe(200);
    expect(requests[0]?.url).toContain(`/v3/session/${state.activeId}/project:acme/`);
    const paused = await fetch(`${manifest.url}/api/pause`, {method: "POST", headers: {cookie, origin: manifest.url, "content-type": "application/json"}, body: "{}"});
    expect(paused.status).toBe(200);
    expect((await inference(manifest.url, manifest.token)).status).toBe(409);
  });

  it("pauses attribution when the current session is archived and restores its ID only after explicit selection", async () => {
    const manifest = await start({});
    const opened = await desktopOpenCommand({ key: "work", stateDir, open: false });
    const bootstrap = await fetch(opened.url, { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
    const headers = { cookie, origin: manifest.url, "content-type": "application/json" };
    const create = await fetch(manifest.url + "/api/sessions", { method: "POST", headers, body: JSON.stringify({ name: "Archive me", project: "acme" }) });
    const id = (await create.json()).activeId;
    expect((await inference(manifest.url, manifest.token)).status).toBe(200);
    const mutate = (action: string) => fetch(`${manifest.url}/api/sessions/${id}/${action}`, { method: "POST", headers, body: "{}" });
    const archived = await mutate("archive");
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({ activeId: null, sessions: [{ id, archivedAt: expect.any(String) }] });
    expect((await inference(manifest.url, manifest.token)).status).toBe(409);
    expect((await mutate("activate")).status).toBe(400);
    expect((await mutate("restore")).status).toBe(200);
    expect((await inference(manifest.url, manifest.token)).status).toBe(409);
    expect((await mutate("activate")).status).toBe(200);
    expect((await inference(manifest.url, manifest.token)).status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(requests[1]?.url);
  });
  it("requires local bearer auth for status, context, activation, open and service stop", async () => {
    const manifest = await start();
    expect((await fetch(`${manifest.url}/opper/status`)).status).toBe(401);
    for (const route of ["context", "activate", "open", "stop"]) {
      expect((await fetch(`${manifest.url}/opper/${route}`, {method: "POST", headers: {"content-type": "application/json"}, body: "{}"})).status).toBe(401);
    }
    expect((await inference(manifest.url, manifest.token)).status).toBe(200);
  });
  it("starts a detached service using the actual CLI, reuses it, and stops only that service", async () => {
    const execute = promisify(execFile);
    const entry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
    const args = ["--import", "tsx", entry, "--key", "work", "proxy", "--state-dir", stateDir, "--no-open"];
    const first = await execute(process.execPath, args, {env: {...process.env, NO_UPDATE_NOTIFIER: "1"}, timeout: 15_000});
    expect(first.stdout).toContain("Sessions: http://127.0.0.1:");
    const manifest = await readDesktopRuntime(stateDir);
    expect(manifest.pid).not.toBe(process.pid);
    await privateFile(join(stateDir, "bridge.log"));
    const state = await fetch(`${manifest.url}/opper/status`, {headers: {authorization: `Bearer ${manifest.token}`}}).then((res) => res.json());
    expect(state.paused).toBe(true);
    const second = await execute(process.execPath, args, {env: {...process.env, NO_UPDATE_NOTIFIER: "1"}, timeout: 15_000});
    expect(second.stdout).toContain("Sessions: ");
    expect((await readDesktopRuntime(stateDir)).pid).toBe(manifest.pid);
    await execute(process.execPath, ["--import", "tsx", entry, "proxy", "stop", "--state-dir", stateDir], {env: {...process.env, NO_UPDATE_NOTIFIER: "1"}, timeout: 15_000});
    await expect(readDesktopRuntime(stateDir)).rejects.toMatchObject({code: "AGENT_CONFIG_CONFLICT"});
    await expect(fetch(`${manifest.url}/opper/status`)).rejects.toThrow();
    // Stop returns only once its lifetime lock and listening socket are gone.
    const reopened = await execute(process.execPath, args, {env: {...process.env, NO_UPDATE_NOTIFIER: "1"}, timeout: 15_000});
    expect(reopened.stdout).toContain("Sessions: ");
    const restarted = await readDesktopRuntime(stateDir);
    expect(restarted.pid).not.toBe(manifest.pid);
    expect(restarted.url).toBe(manifest.url);
    expect(restarted.token).toBe(manifest.token);
  }, 30_000);
  it("refuses a second service in the same state directory without changing the active manifest", async () => {
    await start();
    const original = await readFile(join(stateDir, "bridge.json"), "utf8");
    await expect(desktopStartCommand({ key: "work", stateDir, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    expect(await readFile(join(stateDir, "bridge.json"), "utf8")).toBe(original);
  });
  it("accepts same-owner credential renewal but fails closed after owner changes", async () => {
    const manifest = await start();
    await setSlot("work", { ...slot, baseUrl: origin, apiKey: "renewed-secret", credentialId: "renewed-id" });
    expect((await inference(manifest.url, manifest.token)).status).toBe(200);
    expect(requests[0]?.key).toBe("Bearer renewed-secret");
    await setSlot("work", { ...slot, baseUrl: origin, apiKey: "other-secret", orgId: 99 });
    expect((await inference(manifest.url, manifest.token)).status).toBeGreaterThanOrEqual(400);
    expect(requests).toHaveLength(1);
  });
  it("rejects expired credentials on subsequent requests", async () => {
    const manifest = await start();
    await setSlot("work", { ...slot, baseUrl: origin, expiresAt: "2000-01-01T00:00:00Z" });
    expect((await inference(manifest.url, manifest.token)).status).toBeGreaterThanOrEqual(400);
    expect(requests).toHaveLength(0);
  });
  it("rejects environment keys and mismatched roots before creating runtime state", async () => {
    vi.stubEnv("OPPER_API_KEY", "env-secret");
    await expect(desktopStartCommand({ key: "work", stateDir })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    vi.stubEnv("OPPER_API_KEY", ""); vi.stubEnv("OPPER_BASE_URL", "https://other.example.test");
    await expect(desktopStartCommand({ key: "work", stateDir })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(lstat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses symlinked and non-private state without contacting any endpoint", async () => {
    const manifest = await start();
    const file = join(stateDir, "bridge.json");
    if (process.platform === "win32") await promisify(execFile)("icacls.exe", [file, "/grant", "*S-1-1-0:(R)"]);
    else await chmod(file, 0o644);
    await expect(readDesktopRuntime(stateDir)).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    if (process.platform === "win32") await promisify(execFile)("icacls.exe", [file, "/remove:g", "*S-1-1-0"]);
    else await chmod(file, 0o600);
    const linked = join(directory, "linked");
    await symlink(stateDir, linked, process.platform === "win32" ? "junction" : "dir");
    await expect(readDesktopRuntime(linked)).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    expect(requests).toHaveLength(0);
    expect(manifest.token).toHaveLength(64);
  });
  it("rejects a tampered remote control URL before sending local auth", async () => {
    const manifest = await start();
    await writeFile(join(stateDir, "bridge.json"), JSON.stringify({ ...manifest, url: "https://other.example.test" }), { mode: 0o600 });
    await expect(desktopStatusCommand({ stateDir })).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    // Restore exact manifest so normal shutdown can prove its ownership.
    await writeFile(join(stateDir, "bridge.json"), JSON.stringify(manifest), { mode: 0o600 });
    expect(requests).toHaveLength(0);
  });
  it("restarts safely after a crashed process, replacing only its stale manifest", async () => {
    await mkdir(stateDir, { mode: 0o700 });
    await writeFile(join(stateDir, "bridge.json"), JSON.stringify({ version: 1, url: "http://127.0.0.1:1", token: "a".repeat(64), keyName: "work", origin, pid: 2147483647 }), { mode: 0o600 });
    const manifest = await start();
    expect(manifest.token).not.toBe("a".repeat(64));
    expect(manifest.pid).toBe(process.pid);
    expect((await inference(manifest.url, manifest.token)).status).toBe(200);
  });
  it.each([
    { baseUrl: "https://other.example.test" },
    { user: { email: "other@example.test", name: "Other" } },
    { projectId: 5 },
    { source: "manual" as const },
  ])("fails closed after host, owner, project binding or kind changes (%j)", async (change) => {
    const manifest = await start();
    await setSlot("work", { ...slot, baseUrl: origin, ...change });
    expect((await inference(manifest.url, manifest.token)).status).toBeGreaterThanOrEqual(400);
    expect(requests).toHaveLength(0);
  });
  it("refuses an alive manifest PID even if its runtime lock is absent", async () => {
    await mkdir(stateDir, { mode: 0o700 });
    const previous = { version: 1, url: "http://127.0.0.1:1", token: "a".repeat(64), keyName: "work", origin, pid: process.pid };
    await writeFile(join(stateDir, "bridge.json"), JSON.stringify(previous), { mode: 0o600 });
    await expect(desktopStartCommand({ key: "work", stateDir, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    expect(JSON.parse(await readFile(join(stateDir, "bridge.json"), "utf8"))).toEqual(previous);
  });
});
