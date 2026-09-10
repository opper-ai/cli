import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { getSlot } from "../auth/config.js";
import { configPath as opperConfigPath } from "../auth/paths.js";
import { DEFAULT_MODELS } from "../config/models.js";
import { OPPER_HOST } from "../config/endpoints.js";
import { OpperError } from "../errors.js";
import { run } from "../util/run.js";
import { fetchCodexModelCatalog } from "../setup/codex-models.js";
import { applyDesktopConfig, removeDesktopConfig, readDesktopConfig, DESKTOP_PROVIDER, type DesktopConfigState } from "../setup/codex-desktop-config.js";
import type { AgentAdapter, ConfigureOptions, OpperRouting } from "./types.js";

const MINIMUM_RUNTIME = [0, 153, 4];
function codexHome(): string { return resolve(process.env.CODEX_HOME || join(homedir(), ".codex")); }
function paths() {
  const home = codexHome();
  const directory = join(home, "opper-desktop");
  return { home, directory, config: join(home, "config.toml"), catalog: join(directory, "catalog.json"), auth: join(directory, "auth.mjs"), state: join(directory, "state.json"), lock: join(home, ".opper-desktop.lock") };
}
function appCandidates(): string[] {
  return ["/Applications/ChatGPT.app", "/Applications/Codex.app", join(homedir(), "Applications", "ChatGPT.app"), join(homedir(), "Applications", "Codex.app")];
}
function findApp(): { app: string; runtime: string; version: string } | null {
  if (platform() !== "darwin") return null;
  for (const app of appCandidates()) {
    const runtime = join(app, "Contents", "Resources", "codex");
    if (!existsSync(runtime)) continue;
    const bundle = run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(app, "Contents", "Info.plist")]);
    if (bundle.code !== 0 || bundle.stdout.trim() !== "com.openai.codex") continue;
    const version = run(runtime, ["--version"]);
    const match = version.stdout.match(/codex-cli\s+(\d+\.\d+\.\d+)/);
    if (version.code === 0 && match?.[1]) return { app, runtime, version: match[1] };
  }
  return null;
}
function requireApp() {
  const app = findApp();
  if (!app) throw new OpperError("AGENT_NOT_FOUND", "The Codex/ChatGPT desktop app for macOS is not installed.", "Install the app with local Codex support from https://chatgpt.com/download.");
  const parts = app.version.split(".").map(Number);
  const comparison = parts.findIndex((n, i) => n !== MINIMUM_RUNTIME[i]);
  if (comparison !== -1 && parts[comparison]! < MINIMUM_RUNTIME[comparison]!) {
    throw new OpperError("AGENT_NOT_FOUND", `The app bundles Codex ${app.version}; Opper desktop requires 0.153.4 or later.`, "Update the desktop app and try again.");
  }
  return app;
}

async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
async function checkConfigPaths(): Promise<void> {
  const p = paths();
  for (const file of [p.config, p.auth, p.catalog, p.state, p.directory]) {
    try {
      const info = await lstat(file);
      if (info.isSymbolicLink() || (file === p.directory ? !info.isDirectory() : !info.isFile())) {
        throw new OpperError("AGENT_CONFIG_CONFLICT", `Cannot safely update ${file}: it is linked or is not a regular ${file === p.directory ? "directory" : "file"}.`, "Use a regular config.toml, or a separate CODEX_HOME, to preserve your dotfile links.");
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
}
async function atomicWrite(path: string, contents: string, mode = 0o600): Promise<void> {
  const temporary = `${path}.tmp.${process.pid}`;
  try {
    await writeFile(temporary, contents, { mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
function apiRoot(url: string): string {
  const parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new OpperError("INVALID_ARGUMENT", "Opper API root must be an HTTP(S) URL without credentials, query or fragment.");
  }
  return parsed.href.replace(/\/+$/, "");
}
async function nodeLauncher(): Promise<string> {
  // process.execPath resolves Homebrew's symlink into a versioned Cellar path.
  // Keep the stable launcher when it resolves to the interpreter running us.
  const current = await realpath(process.execPath);
  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    try { if (await realpath(candidate) === current) return candidate; } catch { /* unavailable */ }
  }
  return process.execPath;
}

// This helper is intentionally standalone: it survives npm updates and Finder
// launches, reads the selected slot on every refresh, and never copies its key.
const AUTH_HELPER = `import { readFileSync } from "node:fs";
const [configPath, keyName, expectedHost] = process.argv.slice(2);
try {
  const slot = JSON.parse(readFileSync(configPath, "utf8")).keys?.[keyName];
  if (!slot || typeof slot.apiKey !== "string" || !slot.apiKey.trim()) throw new Error("missing key");
  const host = new URL(slot.baseUrl || "https://api.opper.ai").href.replace(/\\/+$/, "");
  if (host !== expectedHost) throw new Error("key host changed");
  process.stdout.write(slot.apiKey);
} catch {
  process.stderr.write("The selected Opper key is unavailable or its API host changed. Reconfigure Codex desktop with opper.\\n");
  process.exitCode = 1;
}
`;

interface StoredState { version: 1; configExisted: boolean; config: DesktopConfigState; }
async function readState(path: string): Promise<StoredState | undefined> {
  const raw = await readOptional(path);
  if (raw === null) return undefined;
  const state = JSON.parse(raw) as StoredState;
  if (state.version !== 1 || state.config?.version !== 1 || typeof state.config.originalText !== "string" || typeof state.config.appliedText !== "string") {
    throw new OpperError("AGENT_CONFIG_CONFLICT", "Invalid Opper desktop backup. Preserve it and restore the previous Codex configuration before retrying.");
  }
  return state;
}
async function locked<T>(fn: () => Promise<T>): Promise<T> {
  const p = paths();
  await mkdir(p.home, { recursive: true });
  try { await mkdir(p.lock, { mode: 0o700 }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new OpperError("AGENT_CONFIG_CONFLICT", "Another Opper desktop configuration is in progress.", `If no Opper process is running, remove ${p.lock} and retry.`);
    throw e;
  }
  try { return await fn(); } finally { await rm(p.lock, { recursive: true }); }
}

async function setup(opts: ConfigureOptions): Promise<void> {
  requireApp();
  await checkConfigPaths();
  const keyName = opts.keyName ?? "default";
  const slot = await getSlot(keyName);
  if (!slot) throw new OpperError("AUTH_REQUIRED", `No API key stored for slot "${keyName}"`, "Run `opper login` first.");
  if (opts.apiKey && opts.apiKey !== slot.apiKey) throw new OpperError("AGENT_CONFIG_CONFLICT", "The selected Opper key changed while configuring the desktop app. Retry the command.");
  const baseUrl = apiRoot(opts.baseUrl ?? process.env.OPPER_BASE_URL ?? slot.baseUrl ?? OPPER_HOST);
  const model = opts.model ?? DEFAULT_MODELS.opus;
  const catalog = await fetchCodexModelCatalog({ apiKey: slot.apiKey, baseUrl }, model);
  await locked(async () => {
    await checkConfigPaths();
    const p = paths();
    const existing = await readOptional(p.config);
    const previous = await readState(p.state);
    const provider = {
      name: "Opper", base_url: `${baseUrl}/v3/compat`, wire_api: "responses",
      auth: { command: await nodeLauncher(), args: [p.auth, resolve(opperConfigPath()), keyName, apiRoot(slot.baseUrl ?? OPPER_HOST)], refresh_interval_ms: 300_000 },
    };
    const applied = applyDesktopConfig(existing ?? "", { model, model_catalog_json: p.catalog, provider }, previous?.config);
    if (!previous && (existsSync(p.auth) || existsSync(p.catalog))) throw new OpperError("AGENT_CONFIG_CONFLICT", "Unmanaged files already exist in the Opper desktop configuration directory.");
    await mkdir(p.directory, { recursive: true, mode: 0o700 });
    await chmod(p.directory, 0o700);
    const state: StoredState = { version: 1, configExisted: previous?.configExisted ?? existing !== null, config: applied.state };
    const backups = new Map<string, string | null>();
    for (const file of [p.auth, p.catalog, p.state]) backups.set(file, await readOptional(file));
    try {
      await atomicWrite(p.auth, AUTH_HELPER);
      await atomicWrite(p.catalog, JSON.stringify(catalog, null, 2) + "\n");
      await atomicWrite(p.state, JSON.stringify(state, null, 2) + "\n");
      if (await readOptional(p.config) !== existing) throw new OpperError("AGENT_CONFIG_CONFLICT", "Codex settings changed during setup. Retry to preserve those edits.");
      const mode = existing === null ? 0o600 : (await stat(p.config)).mode & 0o777;
      await atomicWrite(p.config, applied.text, mode);
    } catch (e) {
      for (const [file, backup] of backups) {
        if (backup === null) await rm(file, { force: true }); else await atomicWrite(file, backup);
      }
      throw e;
    }
  });
}

async function unconfigure(): Promise<void> {
  const p = paths();
  if (!existsSync(p.state)) return;
  await locked(async () => {
    await checkConfigPaths();
    const state = await readState(p.state);
    if (!state) return;
    const existing = await readOptional(p.config);
    if (existing !== null) {
      const restored = removeDesktopConfig(existing, state.config);
      if (await readOptional(p.config) !== existing) throw new OpperError("AGENT_CONFIG_CONFLICT", "Codex settings changed during removal. Retry to preserve those edits.");
      if (!state.configExisted && restored.trim() === "") await rm(p.config);
      else await atomicWrite(p.config, restored, (await stat(p.config)).mode & 0o777);
    }
    for (const file of [p.auth, p.catalog, p.state]) await rm(file, { force: true });
    // Keep independently added files; only remove the directory when empty.
    try { const { rmdir } = await import("node:fs/promises"); await rmdir(p.directory); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw e; }
  });
}

async function isConfigured(): Promise<boolean> {
  try {
    const p = paths();
    const state = await readState(p.state);
    const text = await readOptional(p.config);
    if (!state || !text || !existsSync(p.auth) || !existsSync(p.catalog)) return false;
    const config = readDesktopConfig(text);
    return config.model_provider === DESKTOP_PROVIDER && config.model_catalog_json === p.catalog;
  } catch { return false; }
}

async function spawn(args: string[], routing: OpperRouting): Promise<number> {
  if (args.length) throw new OpperError("INVALID_ARGUMENT", "codex-desktop does not accept passthrough arguments.");
  const app = requireApp();
  const baseUrl = routing.apiBaseUrl ?? routing.baseUrl.replace(/\/v3\/(?:compat|session\/[^/]+)(?:\/.*)?$/, "");
  await setup({ apiKey: routing.apiKey, keyName: routing.keyName ?? "default", baseUrl, model: routing.model });
  const userData = process.env.CODEX_ELECTRON_USER_DATA_PATH;
  const executable = run("/usr/bin/plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", join(app.app, "Contents", "Info.plist")]);
  const binary = join(app.app, "Contents", "MacOS", executable.stdout.trim() || "ChatGPT");
  const processes = run("pgrep", ["-f", `^${binary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([[:space:]]|$)`]);
  if (processes.code !== 0 && processes.code !== 1) throw new OpperError("AGENT_CONFIG_CONFLICT", "Opper is configured, but the app's running state could not be checked.", "Quit and reopen the Codex/ChatGPT app manually.");
  const running = processes.code === 0;
  if (running && !userData) {
    throw new OpperError("AGENT_CONFIG_CONFLICT", "Opper is configured, but the Codex/ChatGPT app is already running.", "Quit and reopen the app to use Opper for new local Codex tasks. Existing tasks keep their provider.");
  }
  const openArgs = ["-a", app.app, "--env", `CODEX_HOME=${codexHome()}`];
  if (userData) openArgs.push("-n", "--env", `CODEX_ELECTRON_USER_DATA_PATH=${resolve(userData)}`, "--args", `--user-data-dir=${resolve(userData)}`);
  const opened = run("open", openArgs);
  if (opened.code !== 0) throw new OpperError("AGENT_NOT_FOUND", "Opper is configured, but the Codex/ChatGPT app could not be opened.", "Open the app manually or retry `opper launch codex-desktop`.");
  console.log("Opened Codex/ChatGPT with Opper for new local Codex tasks.");
  return 0;
}

export const codexDesktop: AgentAdapter = {
  name: "codex-desktop", displayName: "Codex Desktop (ChatGPT)", docsUrl: "https://chatgpt.com/download",
  launchesInBackground: true,
  async detect() { const app = findApp(); return { installed: app !== null, ...(app ? { version: app.version } : {}), configPath: paths().config }; },
  isConfigured,
  configure: (opts) => setup(opts),
  unconfigure,
  spawn,
};
