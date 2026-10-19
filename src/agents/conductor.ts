import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getSlot, isSlotExpired } from "../auth/config.js";
import { configPath, opperHome } from "../auth/paths.js";
import { OPPER_HOST } from "../config/endpoints.js";
import { DEFAULT_MODELS } from "../config/models.js";
import { OpperError } from "../errors.js";
import { fetchCodexModelCatalog } from "../setup/codex-models.js";
import { run } from "../util/run.js";
import type { AgentAdapter, ConfigureOptions } from "./types.js";

const REQUIRED = ["codex", "launcher.mjs", "auth.mjs", "catalog.json"] as const;
const OPTIONAL = ["node", "NODE-LICENSE"] as const;
const FILES = [...REQUIRED, ...OPTIONAL, "state.json"];
type Artifact = { data: Buffer; mode: number };
type State = { version: 1; files: Record<string, { sha256: string; mode: number }> };
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const conflict = (message: string) => new OpperError("AGENT_CONFIG_CONFLICT", message);
function paths() {
  const home = resolve(opperHome());
  return { home, directory: join(home, "conductor"), lock: join(home, ".conductor.lock") };
}
function binaryRoot() { return join(homedir(), "Library", "Application Support", "com.conductor.app", "agent-binaries", "codex"); }
function rootUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new OpperError("INVALID_ARGUMENT", "Opper API root must be an HTTP(S) URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new OpperError("INVALID_ARGUMENT", "Opper API root must not contain credentials, query or fragment.");
  return url.href.replace(/\/+$/, "");
}
function compareVersion(a: string, b: string): number {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  return left[0]! - right[0]! || left[1]! - right[1]! || left[2]! - right[2]!;
}
function findRuntime(): { path: string; version: string } | undefined {
  if (platform() !== "darwin") return;
  const apps = ["/Applications/Conductor.app", join(homedir(), "Applications", "Conductor.app")];
  if (!apps.some(app => {
    const result = run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(app, "Contents", "Info.plist")], {timeout: 5_000});
    return result.code === 0 && result.stdout.trim() === "com.conductor.app";
  })) return;
  let versions: string[];
  try { versions = readdirSync(binaryRoot()).filter(name => /^\d+\.\d+\.\d+$/.test(name)).sort((a, b) => compareVersion(b, a)); } catch { return; }
  for (const version of versions) {
    const path = join(binaryRoot(), version, "codex");
    const result = run(path, ["--version"], {timeout: 5_000});
    const actual = result.stdout.match(/^codex-cli (\d+\.\d+\.\d+)\s*$/)?.[1];
    if (result.code === 0 && actual && compareVersion(actual, "0.153.4") >= 0) return {path, version: actual};
  }
  return;
}
async function regular(path: string, directory = false): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw conflict(`Cannot safely update ${path}: linked or unexpected file type.`);
    return true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function snapshot(directory: string): Promise<Map<string, Artifact>> {
  await regular(directory, true);
  const files = new Map<string, Artifact>();
  for (const name of FILES) {
    const path = join(directory, name);
    if (await regular(path)) files.set(name, {data: await readFile(path), mode: (await lstat(path)).mode & 0o777});
  }
  return files;
}
function stateOf(files: Map<string, Artifact>): State | undefined {
  const raw = files.get("state.json");
  if (!raw) {
    if (files.size) throw conflict("Unmanaged files already exist in the Conductor integration directory; they were preserved.");
    return;
  }
  let state: State;
  try { state = JSON.parse(raw.data.toString()); } catch { throw conflict("Invalid Conductor integration ownership state; preserve its files before retrying."); }
  if (state?.version !== 1 || !state.files || typeof state.files !== "object" || Array.isArray(state.files) ||
      REQUIRED.some(name => !Object.hasOwn(state.files, name)) ||
      Boolean(state.files.node) !== Boolean(state.files["NODE-LICENSE"]) ||
      Object.entries(state.files).some(([name, value]) => ![...REQUIRED, ...OPTIONAL].includes(name as typeof REQUIRED[number]) || !/^[a-f0-9]{64}$/.test(value?.sha256) || ![0o600, 0o700].includes(value?.mode))) {
    throw conflict("Invalid Conductor integration ownership state; preserve its files before retrying.");
  }
  for (const [name, artifact] of files) {
    if (name === "state.json") continue;
    const expected = state.files[name];
    if (!expected || digest(artifact.data) !== expected.sha256 || artifact.mode !== expected.mode) throw conflict(`The managed Conductor file ${name} changed; it was preserved.`);
  }
  return state;
}
async function atomic(path: string, artifact: Artifact): Promise<void> {
  const temporary = `${path}.tmp.${randomUUID()}`;
  let created = false;
  try {
    await writeFile(temporary, artifact.data, {flag: "wx", mode: artifact.mode}); created = true;
    await chmod(temporary, artifact.mode); await rename(temporary, path);
  } finally { if (created) await rm(temporary, {force: true}); }
}
async function locked<T>(fn: () => Promise<T>): Promise<T> {
  const p = paths(); await regular(p.home, true); await mkdir(p.home, {recursive: true, mode: 0o700});
  try { await mkdir(p.lock, {mode: 0o700}); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw conflict("Another Conductor configuration is in progress. Retry after it finishes.");
    throw error;
  }
  try { return await fn(); } finally { await rmdir(p.lock); }
}
function toml(value: unknown): string {
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`;
  return `{ ${Object.entries(value as Record<string, unknown>).map(([key, item]) => `${JSON.stringify(key)} = ${toml(item)}`).join(", ")} }`;
}
async function nodeLauncher(): Promise<string> {
  const actual = await realpath(process.execPath);
  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    try { if (await realpath(candidate) === actual) return candidate; } catch { /* not this Node installation */ }
  }
  return process.execPath;
}
const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

async function configure(opts: ConfigureOptions = {}): Promise<void> {
  if (opts.codexHome !== undefined || opts.desktopProxy) throw new OpperError("INVALID_ARGUMENT", "Conductor uses its managed Codex executable; --codex-home and --proxy are not supported.");
  if (process.env.OPPER_API_KEY) throw new OpperError("AUTH_REQUIRED", "Conductor requires a stored Opper credential for future GUI sessions.", "Store the key with opper login, then unset OPPER_API_KEY before configuring.");
  if (!findRuntime()) throw new OpperError("AGENT_NOT_FOUND", "Conductor with a managed Codex runtime 0.153.4 or later was not found.", "Install Conductor and initialize its Codex harness, then retry.");
  const keyName = opts.keyName ?? "default", slot = await getSlot(keyName);
  if (!slot) throw new OpperError("AUTH_REQUIRED", `No stored Opper credential for slot ${JSON.stringify(keyName)}.`, "Run opper login first.");
  if (isSlotExpired(slot)) throw new OpperError("AUTH_EXPIRED", "The selected Opper credential expired. Renew it before configuring Conductor.");
  const host = rootUrl(slot.baseUrl || OPPER_HOST);
  const selectedHost = rootUrl(opts.baseUrl ?? process.env.OPPER_BASE_URL ?? host);
  if (selectedHost !== host || (opts.apiKey !== undefined && opts.apiKey !== slot.apiKey)) throw conflict("The selected credential or API host differs from its stored slot. Retry with the matching slot.");
  const model = opts.model ?? DEFAULT_MODELS.opus;
  const catalog = await fetchCodexModelCatalog({apiKey: slot.apiKey, baseUrl: host, ...(opts.projectUuid ? {projectUuid: opts.projectUuid} : {})}, model);
  const p = paths(), binding = {configPath: resolve(configPath()), keyName, host, org: slot.orgId === undefined ? null : String(slot.orgId)};
  await locked(async () => {
    await regular(p.directory, true);
    const previous = await snapshot(p.directory), state = stateOf(previous);
    await mkdir(p.directory, {recursive: true, mode: 0o700});
    const bundled = process.env.OPPER_DISTRIBUTION === "bundle";
    const node = bundled ? join(p.directory, "node") : await nodeLauncher();
    const helper = `import {readFileSync} from "node:fs";
try {
  const binding = JSON.parse(process.argv[2]);
  const slot = JSON.parse(readFileSync(binding.configPath, "utf8")).keys?.[binding.keyName];
  if (!slot || typeof slot.apiKey !== "string" || !slot.apiKey.trim()) throw new Error();
  if (slot.expiresAt && (!Number.isFinite(Date.parse(slot.expiresAt)) || Date.parse(slot.expiresAt) <= Date.now())) throw new Error();
  if ((slot.orgId === undefined ? null : String(slot.orgId)) !== binding.org) throw new Error();
  if (new URL(slot.baseUrl || "https://api.opper.ai").href.replace(/\\/+$/, "") !== binding.host) throw new Error();
  process.stdout.write(slot.apiKey);
} catch {
  process.stderr.write("The selected Opper credential is unavailable, expired, or its organization/API host changed. Renew it or reconfigure Conductor.\\n");
  process.exitCode = 1;
}
`;
    const provider = {name: "Opper", base_url: `${host}/v3/compat`, wire_api: "responses", requires_openai_auth: false, supports_websockets: false,
      ...(opts.projectUuid ? {http_headers: {"X-Opper-Project": opts.projectUuid}} : {}),
      auth: {command: node, args: [join(p.directory, "auth.mjs"), JSON.stringify(binding)], refresh_interval_ms: 300_000}};
    const overrides = ["-c", 'model_provider="opper-conductor"', "-c", `model_providers.opper-conductor=${toml(provider)}`, "-c", `model_catalog_json=${toml(join(p.directory, "catalog.json"))}`, "-c", `model=${toml(model)}`, "-c", 'web_search="disabled"'];
    const launcher = `import {readdirSync} from "node:fs";
import {join} from "node:path";
import {spawn, spawnSync} from "node:child_process";
const directory = ${JSON.stringify(binaryRoot())};
const compare = (a,b) => {const x=a.split(".").map(Number),y=b.split(".").map(Number);return x[0]-y[0] || x[1]-y[1] || x[2]-y[2];};
try {
  let target;
  for (const version of readdirSync(directory).filter(v=>/^\\d+\\.\\d+\\.\\d+$/.test(v)).sort((a,b)=>compare(b,a))) {
    const path=join(directory,version,"codex");
    const result=spawnSync(path,["--version"],{encoding:"utf8",timeout:5000});
    const actual=result.stdout?.match(/^codex-cli (\\d+\\.\\d+\\.\\d+)\\s*$/)?.[1];
    if (result.status===0 && actual && compare(actual,"0.153.4")>=0) {target=path;break;}
  }
  if (!target) throw new Error();
  const child=spawn(target,[...process.argv.slice(2),...${JSON.stringify(overrides)}],{stdio:"inherit"});
  const handlers=new Map(["SIGTERM","SIGINT","SIGHUP"].map(signal=>[signal,()=>child.kill(signal)]));
  for(const [signal,handler] of handlers)process.on(signal,handler);
  child.on("error",()=>{process.stderr.write("Could not start Conductor's managed Codex. Reconfigure with opper.\\n");process.exitCode=1;});
  child.on("exit",(code,signal)=>{for(const [name,handler] of handlers)process.removeListener(name,handler);if(signal)process.kill(process.pid,signal);else process.exitCode=code??1;});
} catch {process.stderr.write("No supported Conductor Codex runtime found. Initialize Codex in Conductor and reconfigure with opper.\\n");process.exitCode=1;}
`;
    const generated = new Map<string, Artifact>();
    const add = (name: string, data: string | Buffer, mode = 0o600) => generated.set(name, {data: Buffer.isBuffer(data) ? data : Buffer.from(data), mode});
    add("codex", `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(join(p.directory, "launcher.mjs"))} "$@"\n`, 0o700);
    add("launcher.mjs", launcher); add("auth.mjs", helper); add("catalog.json", JSON.stringify(catalog, null, 2) + "\n");
    if (bundled) { add("node", await readFile(process.execPath), 0o700); add("NODE-LICENSE", await readFile(join(dirname(process.execPath), "NODE-LICENSE"))); }
    const next: State = {version: 1, files: Object.fromEntries([...generated].map(([name, artifact]) => [name, {sha256: digest(artifact.data), mode: artifact.mode}]))};
    add("state.json", JSON.stringify(next, null, 2) + "\n");
    const changed: string[] = [];
    try {
      for (const name of FILES) {
        const artifact = generated.get(name);
        if (artifact) { await atomic(join(p.directory, name), artifact); changed.push(name); }
        else if (state?.files[name] && previous.has(name)) { await rm(join(p.directory, name)); changed.push(name); }
      }
    } catch (error) {
      for (const name of changed.reverse()) {
        const original = previous.get(name);
        if (original) await atomic(join(p.directory, name), original); else await rm(join(p.directory, name), {force: true});
      }
      throw error;
    }
  });
  console.log(`Prepared Conductor (Codex): ${join(p.directory, "codex")}\nIn Conductor, choose Settings → Agents → Codex → CLI, then select this custom executable. Restart its Codex sessions and select an Opper model. Prepared files do not verify your UI selection. Re-run configure to refresh the model catalog.`);
}

async function unconfigure(): Promise<void> {
  const p = paths();
  if (!await regular(p.directory, true)) return;
  await locked(async () => {
    const files = await snapshot(p.directory), state = stateOf(files);
    if (!state) return;
    for (const name of Object.keys(state.files)) if (files.has(name)) await rm(join(p.directory, name));
    await rm(join(p.directory, "state.json"));
    try { await rmdir(p.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error; }
  });
  console.log("Removed the prepared Conductor integration. Restore the managed Codex executable in Conductor settings before starting another session.");
}

export const conductor: AgentAdapter = {
  name: "conductor", displayName: "Conductor (Codex)", docsUrl: "https://www.conductor.build/docs/reference/harnesses/codex",
  async detect() { const runtime = findRuntime(); return {installed: runtime !== undefined, ...(runtime ? {version: runtime.version} : {}), configPath: join(paths().directory, "codex")}; },
  async isConfigured() {
    try { const files = await snapshot(paths().directory), state = stateOf(files); return state !== undefined && Object.keys(state.files).every(name => files.has(name)); } catch { return false; }
  },
  configure, unconfigure,
};
