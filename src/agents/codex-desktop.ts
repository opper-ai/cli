import { existsSync, readdirSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getSlot } from "../auth/config.js";
import { configPath as opperConfigPath } from "../auth/paths.js";
import { DEFAULT_MODELS } from "../config/models.js";
import { OPPER_HOST } from "../config/endpoints.js";
import { OpperError } from "../errors.js";
import { run } from "../util/run.js";
import { windowsDesktopApps, powerShellLiteral } from "../util/windows-desktop.js";
import { fetchCodexModelCatalog } from "../setup/codex-models.js";
import { codexCatalogUrl, nativeCodexCatalog, nativeCodexRefreshKinds, supportsNativeCodexCatalog } from "../setup/codex-native-catalog.js";
import { applyDesktopConfig, removeDesktopConfig, readDesktopConfig, DESKTOP_PROVIDER, type DesktopConfigState } from "../setup/codex-desktop-config.js";
import type { AgentAdapter, ConfigureOptions, OpperRouting, SpawnOptions, UnconfigureOptions } from "./types.js";
import { POWERSHELL_PRIVATE_STATE_SCRIPT, ensurePrivateStateDirectory } from "../desktop/private-state.js";

const MINIMUM_RUNTIME = [0, 153, 4];
function codexHome(explicit?: string): string {
  if (explicit !== undefined && !explicit.trim()) throw new OpperError("INVALID_ARGUMENT", "--codex-home must be a non-empty path.");
  return resolve(explicit ?? (process.env.CODEX_HOME || join(homedir(), ".codex")));
}
function paths(home = codexHome()) {
  const directory = join(home, "opper-desktop");
  return { home, directory, config: join(home, "config.toml"), catalog: join(directory, "catalog.json"), auth: join(directory, "auth.mjs"), state: join(directory, "state.json"), runtime: join(directory, process.platform === "win32" ? "node.exe" : "node"), runtimeLicense: join(directory, "NODE-LICENSE"), lock: join(home, ".opper-desktop.lock") };
}
function appCandidates(): string[] {
  return ["/Applications/ChatGPT.app", "/Applications/Codex.app", join(homedir(), "Applications", "ChatGPT.app"), join(homedir(), "Applications", "Codex.app")];
}
function isSupportedRuntime(version: string): boolean {
  const parts = version.split(".").map(Number);
  const comparison = parts.findIndex((n, i) => n !== MINIMUM_RUNTIME[i]);
  return comparison === -1 || parts[comparison]! > MINIMUM_RUNTIME[comparison]!;
}
interface DesktopApp { app: string; runtime: string; version: string; executable?: string; aumid?: string }
function windowsRuntime(executable: string): string | undefined {
  const resources = join(dirname(executable), "resources");
  const candidates = [join(resources, "codex.exe"), join(resources, "codex-cli", "bin", "codex.exe")];
  for (const target of ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"]) {
    candidates.push(join(resources, "codex-cli", "vendor", target, "codex", "codex.exe"));
  }
  const known = candidates.find((candidate) => existsSync(candidate));
  if (known) return known;
  // Packaging layouts can change without moving the registered app executable.
  // Stay inside its resource directory and bound the discovery work.
  let visited = 0;
  function find(directory: string, depth: number): string | undefined {
    if (depth > 6 || visited > 2000) return undefined;
    let entries;
    try { entries = readdirSync(directory, {withFileTypes: true}); } catch { return undefined; }
    for (const entry of entries) {
      if (++visited > 2000) return undefined;
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === "codex.exe") return path;
      if (entry.isDirectory()) { const found = find(path, depth + 1); if (found) return found; }
    }
    return undefined;
  }
  return find(resources, 0);
}
function findWindowsApp(): DesktopApp | null {
  let outdated: DesktopApp | null = null;
  for (const app of windowsDesktopApps("OpenAI.Codex")) {
    const runtime = windowsRuntime(app.executable);
    if (!runtime) continue;
    const result = run(runtime, ["--version"], {timeout: 5_000});
    const version = result.stdout.match(/codex-cli\s+(\d+\.\d+\.\d+)/)?.[1];
    if (result.code !== 0 || !version) continue;
    const found: DesktopApp = {app: app.installLocation, runtime, version, executable: app.executable, aumid: app.aumid};
    if (isSupportedRuntime(version)) return found;
    outdated ??= found;
  }
  return outdated;
}
function findApp(): DesktopApp | null {
  if (platform() === "win32") return findWindowsApp();
  if (platform() !== "darwin") return null;
  let outdatedApp: { app: string; runtime: string; version: string } | null = null;
  for (const app of appCandidates()) {
    const runtime = [
      join(app, "Contents", "Resources", "codex"),
      join(app, "Contents", "Resources", "codex-cli", "bin", "codex"),
    ].find((candidate) => existsSync(candidate));
    if (!runtime) continue;
    const bundle = run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(app, "Contents", "Info.plist")]);
    if (bundle.code !== 0 || bundle.stdout.trim() !== "com.openai.codex") continue;
    const version = run(runtime, ["--version"]);
    const match = version.stdout.match(/codex-cli\s+(\d+\.\d+\.\d+)/);
    if (version.code === 0 && match?.[1]) {
      const candidate = { app, runtime, version: match[1] };
      if (isSupportedRuntime(candidate.version)) return candidate;
      // Keep an installed copy for the update guidance if no candidate is usable.
      outdatedApp ??= candidate;
    }
  }
  return outdatedApp;
}
function requireApp() {
  const app = findApp();
  if (!app) throw new OpperError("AGENT_NOT_FOUND", "The Codex/ChatGPT desktop app with a supported bundled local runtime was not found.", "Install the app with local Codex support from https://chatgpt.com/download.");
  if (!isSupportedRuntime(app.version)) {
    throw new OpperError("AGENT_NOT_FOUND", `The app bundles Codex ${app.version}; Opper desktop requires 0.153.4 or later.`, "Update the desktop app and try again.");
  }
  return app;
}

async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
async function checkConfigPaths(home: string): Promise<void> {
  const p = paths(home);
  for (const file of [p.config, p.auth, p.catalog, p.state, p.runtime, p.runtimeLicense, p.directory]) {
    try {
      const info = await lstat(file);
      if (info.isSymbolicLink() || (file === p.directory ? !info.isDirectory() : !info.isFile())) {
        throw new OpperError("AGENT_CONFIG_CONFLICT", `Cannot safely update ${file}: it is linked or is not a regular ${file === p.directory ? "directory" : "file"}.`, "Use a regular config.toml, or a separate CODEX_HOME, to preserve your dotfile links.");
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
}
async function atomicWrite(path: string, contents: string | Buffer, mode = 0o600): Promise<void> {
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
const [configPath, keyName, expectedHost, expectedOrg] = process.argv.slice(2);
try {
  const slot = JSON.parse(readFileSync(configPath, "utf8")).keys?.[keyName];
  if (!slot || typeof slot.apiKey !== "string" || !slot.apiKey.trim()) throw new Error("missing key");
  if (slot.expiresAt && (!Number.isFinite(Date.parse(slot.expiresAt)) || Date.parse(slot.expiresAt) <= Date.now())) throw new Error("expired key");
  if (expectedOrg && String(slot.orgId) !== expectedOrg) throw new Error("key organization changed");
  const host = new URL(slot.baseUrl || "https://api.opper.ai").href.replace(/\\/+$/, "");
  if (host !== expectedHost) throw new Error("key host changed");
  process.stdout.write(slot.apiKey);
} catch {
  process.stderr.write("The selected Opper key is unavailable, expired, or its organization/API host changed. Renew the key and reconfigure Codex desktop with opper.\\n");
  process.exitCode = 1;
}
`;

// Read only the local bridge's credential; the upstream key remains with the bridge.
const PROXY_AUTH_HELPER = `import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { execFile } from "node:child_process";
const [stateDir, expectedEndpoint] = process.argv.slice(2);
let file;
let stage = "state directory";
let nativeFailure;
try {
  const directory = lstatSync(stateDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (process.platform !== "win32" && (directory.mode & 0o077) !== 0) || (process.getuid && directory.uid !== process.getuid())) throw new Error("invalid directory");
  stage = "state file";
  file = openSync(join(stateDir, "bridge.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  const info = fstatSync(file);
  if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0) || (process.getuid && info.uid !== process.getuid()) || info.size > 16384) throw new Error("invalid file");
  if (process.platform === "win32") {
    stage = "Windows access controls";
    const executable = win32.join(process.env.SystemRoot || process.env.WINDIR || "C:\\\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = await new Promise((resolve, reject) => {
      const child = execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", ${JSON.stringify(Buffer.from(POWERSHELL_PRIVATE_STATE_SCRIPT, "utf16le").toString("base64"))}], {encoding: "utf8", timeout: 15000, maxBuffer: 16384, windowsHide: true}, (cause, stdout, stderr) => {
        if (cause) {
          let output;
          try { output = JSON.parse(stdout.trim()); } catch {}
          nativeFailure = {killed: cause.killed === true, signal: ["SIGTERM", "SIGKILL", "SIGINT"].includes(cause.signal) ? cause.signal : null,
            exitCode: Number.isSafeInteger(cause.code) ? cause.code : null,
            code: ["ENOENT", "EACCES", "EPERM", "ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"].includes(cause.code) ? cause.code : null,
            resultCode: ["ENOENT", "AGENT_CONFIG_CONFLICT"].includes(output?.code) ? output.code : null, stderrPresent: !!stderr?.trim()};
        }
        if (cause) reject(cause); else resolve(stdout);
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify({path: join(stateDir, "bridge.json"), kind: "file", create: false}));
    });
    if (JSON.parse(result.trim()).ok !== true) throw new Error("invalid Windows access controls");
  }
  stage = "runtime manifest";
  const bridge = JSON.parse(readFileSync(file, "utf8"));
  if (bridge.version !== 1 || typeof bridge.url !== "string" || typeof bridge.token !== "string" || !/^[a-f0-9]{64}$/.test(bridge.token) || !Number.isSafeInteger(bridge.pid) || bridge.pid <= 0) throw new Error("invalid runtime");
  const endpoint = new URL(bridge.url);
  stage = "endpoint";
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash || endpoint.origin !== expectedEndpoint) throw new Error("changed endpoint");
  stage = "proxy process";
  process.kill(bridge.pid, 0);
  process.stdout.write(bridge.token);
} catch (cause) {
  const code = ["ENOENT", "EACCES", "EPERM", "ETIMEDOUT"].includes(cause?.code) ? " (" + cause.code + ")" : "";
  process.stderr.write("Local proxy validation failed at " + stage + code + ".\\n");
  if (nativeFailure) process.stderr.write("Native validation process: " + JSON.stringify(nativeFailure) + "\\n");
  process.stderr.write("The local Opper proxy is unavailable or its endpoint changed. Start it with opper proxy, or reconfigure and relaunch with opper launch --proxy codex-desktop, preserving your --state-dir and --codex-home options.\\n");
  process.exitCode = 1;
} finally { if (file !== undefined) closeSync(file); }
`;

function proxySettings(proxy: NonNullable<ConfigureOptions["desktopProxy"]>) {
  let endpoint: URL;
  try {endpoint = new URL(proxy.baseUrl);} catch {throw new OpperError("INVALID_ARGUMENT", "Desktop proxy must use an HTTP endpoint on 127.0.0.1 with an explicit port.");}
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash || !proxy.stateDir?.trim() || !/^[a-f0-9]{64}$/.test(proxy.token)) {
    throw new OpperError("INVALID_ARGUMENT", "Desktop proxy requires a local HTTP root endpoint, private state directory and local credential.");
  }
  return {baseUrl: endpoint.origin, stateDir: resolve(proxy.stateDir)};
}

interface StoredState { version: 1; configExisted: boolean; config: DesktopConfigState; bundledRuntime?: boolean; projectUuid?: string; }
async function readState(path: string): Promise<StoredState | undefined> {
  const raw = await readOptional(path);
  if (raw === null) return undefined;
  const state = JSON.parse(raw) as StoredState;
  if (state.version !== 1 || state.config?.version !== 1 || typeof state.config.originalText !== "string" || typeof state.config.appliedText !== "string" || (state.bundledRuntime !== undefined && typeof state.bundledRuntime !== "boolean") || (state.projectUuid !== undefined && typeof state.projectUuid !== "string")) {
    throw new OpperError("AGENT_CONFIG_CONFLICT", "Invalid Opper desktop backup. Preserve it and restore the previous Codex configuration before retrying.");
  }
  return state;
}
async function locked<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const p = paths(home);
  await mkdir(p.home, { recursive: true });
  try { await mkdir(p.lock, { mode: 0o700 }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new OpperError("AGENT_CONFIG_CONFLICT", "Another Opper desktop configuration is in progress.", `If no Opper process is running, remove ${p.lock} and retry.`);
    throw e;
  }
  try { return await fn(); } finally { await rm(p.lock, { recursive: true }); }
}

interface ConfiguredDesktop { home: string; credentialHome: string; keyName: string; baseUrl: string; model: string; projectUuid?: string | undefined; proxyStateDir?: string; }

async function setup(opts: ConfigureOptions, fallbackModel: string = DEFAULT_MODELS.opus): Promise<ConfiguredDesktop> {
  if (process.env.OPPER_API_KEY) throw new OpperError("AUTH_REQUIRED", "Codex Desktop requires a stored Opper credential so Finder launches can refresh it.", "Store the key in its own CLI slot and unset OPPER_API_KEY before configuring or launching Codex Desktop.");
  const home = codexHome(opts.codexHome);
  const app = requireApp();
  await checkConfigPaths(home);
  const keyName = opts.keyName ?? "default";
  const slot = await getSlot(keyName);
  if (!slot) throw new OpperError("AUTH_REQUIRED", `No API key stored for slot "${keyName}"`, "Run `opper login` first.");
  if (opts.apiKey && opts.apiKey !== slot.apiKey) throw new OpperError("AGENT_CONFIG_CONFLICT", "The selected Opper key changed while configuring the desktop app. Retry the command.");
  const baseUrl = apiRoot(opts.baseUrl ?? process.env.OPPER_BASE_URL ?? slot.baseUrl ?? OPPER_HOST);
  const proxy = opts.desktopProxy ? proxySettings(opts.desktopProxy) : undefined;
  let model = opts.model ?? fallbackModel;
  let projectUuid = opts.projectUuid;
  await locked(home, async () => {
    await checkConfigPaths(home);
    const p = paths(home);
    const existing = await readOptional(p.config);
    const previous = await readState(p.state);
    const current = readDesktopConfig(existing ?? "");
    if (previous && opts.model === undefined) {
      // The app picker may change model without updating our installation
      // snapshot. Preserve that choice on refresh and ordinary relaunch.
      model = current.model_provider === DESKTOP_PROVIDER && typeof current.model === "string"
        ? current.model : previous.config.settings.model;
    }
    projectUuid ??= previous?.projectUuid;
    if (projectUuid === undefined) {
      const headers = previous?.config.settings.provider.http_headers;
      if (headers && typeof headers === "object") {
        const saved = Object.entries(headers).find(([name]) => name.toLowerCase() === "x-opper-project")?.[1];
        if (typeof saved === "string") projectUuid = saved;
      }
    }
    if (proxy && projectUuid !== opts.projectUuid) throw new OpperError("AGENT_CONFIG_CONFLICT", "The existing Codex Desktop project differs from the new proxy scope. Repeat --project-uuid for that project when configuring the proxy; existing settings were preserved.");
    const bundled = process.env.OPPER_DISTRIBUTION === "bundle";
    if (!previous?.bundledRuntime && (existsSync(p.runtime) || existsSync(p.runtimeLicense))) {
      throw new OpperError("AGENT_CONFIG_CONFLICT", "Unmanaged Node runtime files already exist in the Opper desktop configuration directory.");
    }
    const provider: Record<string, unknown> = {
      name: "Opper", base_url: `${proxy?.baseUrl ?? baseUrl}/v3/compat`, wire_api: "responses",
      ...(proxy ? {supports_websockets: false} : {}),
      ...(!proxy && projectUuid ? { http_headers: { "X-Opper-Project": projectUuid } } : {}),
      auth: { command: bundled ? p.runtime : await nodeLauncher(), args: proxy ? [p.auth, proxy.stateDir, proxy.baseUrl] : [p.auth, resolve(opperConfigPath()), keyName, apiRoot(slot.baseUrl ?? OPPER_HOST), slot.orgId ? String(slot.orgId) : ""], refresh_interval_ms: 300_000 },
    };
    // Validate ownership before discovery; never replace an independently
    // edited provider or manually configured native URL.
    applyDesktopConfig(existing ?? "", { model, model_catalog_json: p.catalog, provider }, previous?.config);
    if (!previous && (existsSync(p.auth) || existsSync(p.catalog))) throw new OpperError("AGENT_CONFIG_CONFLICT", "Unmanaged files already exist in the Opper desktop configuration directory.");
    const previousCatalog = previous ? await readOptional(p.catalog) : null;
    let preserveIds: string[] = [];
    if (previousCatalog !== null) {
      try {
        const parsed = JSON.parse(previousCatalog) as { models?: { slug?: unknown }[] };
        if (!Array.isArray(parsed.models) || parsed.models.some((entry) => !entry || typeof entry.slug !== "string")) throw new Error("invalid catalog");
        preserveIds = parsed.models.map((entry) => entry.slug as string);
      } catch {
        throw new OpperError("AGENT_CONFIG_CONFLICT", "The existing Opper desktop catalog is invalid. Preserve it and restore a valid catalog before refreshing.");
      }
    }
    // Only the freshly authorized gateway entries can be retained. Revoked
    // deployments never survive merely because a previous picker listed them.
    const context = { apiKey: slot.apiKey, baseUrl, ...(projectUuid ? { projectUuid } : {}) };
    const previousUrl = previous?.config.settings.provider.model_catalog_url;
    const kinds = nativeCodexRefreshKinds(model, opts.modelKinds, typeof previousUrl === "string" ? previousUrl : undefined, previousCatalog !== null);
    const native = supportsNativeCodexCatalog(app.runtime, home) ? await nativeCodexCatalog(context, model, kinds) : undefined;
    if (native) provider.model_catalog_url = proxy ? codexCatalogUrl(proxy.baseUrl, model, kinds) : native.url;
    const catalog = native ? undefined : await fetchCodexModelCatalog(context, model,
      { ...(opts.modelKinds ? { modelKinds: opts.modelKinds } : {}), ...(typeof previousUrl === "string" ? { modelKinds: kinds } : {}), preserveIds });
    const applied = applyDesktopConfig(existing ?? "", { model, ...(!native ? { model_catalog_json: p.catalog } : {}), provider }, previous?.config);
    if (await readOptional(p.config) !== existing || (previous && await readOptional(p.catalog) !== previousCatalog)) {
      throw new OpperError("AGENT_CONFIG_CONFLICT", "Codex settings changed during discovery. Retry to preserve those edits.");
    }
    if (process.platform === "win32") await ensurePrivateStateDirectory(p.directory, true);
    else {
      await mkdir(p.directory, { recursive: true, mode: 0o700 });
      await chmod(p.directory, 0o700);
    }
    const state: StoredState = { version: 1, configExisted: previous?.configExisted ?? existing !== null, config: applied.state, ...(projectUuid ? {projectUuid} : {}), ...((bundled || previous?.bundledRuntime) ? { bundledRuntime: true } : {}) };
    const backups = new Map<string, { contents: Buffer; mode: number } | null>();
    for (const file of [p.auth, p.catalog, p.state, ...(bundled ? [p.runtime, p.runtimeLicense] : [])]) {
      try { backups.set(file, { contents: await readFile(file), mode: (await stat(file)).mode & 0o777 }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; backups.set(file, null); }
    }
    try {
      // A version manager can prune the bundle after upgrading. Desktop auth
      // must survive that independently, just like the standalone auth helper.
      if (bundled) {
        await atomicWrite(p.runtime, await readFile(process.execPath), 0o700);
        await atomicWrite(p.runtimeLicense, await readFile(join(dirname(process.execPath), "NODE-LICENSE")));
      }
      await atomicWrite(p.auth, proxy ? PROXY_AUTH_HELPER : AUTH_HELPER);
      if (native) await rm(p.catalog, { force: true });
      else await atomicWrite(p.catalog, JSON.stringify(catalog, null, 2) + "\n");
      await atomicWrite(p.state, JSON.stringify(state, null, 2) + "\n");
      if (await readOptional(p.config) !== existing) throw new OpperError("AGENT_CONFIG_CONFLICT", "Codex settings changed during setup. Retry to preserve those edits.");
      const mode = existing === null ? 0o600 : (await stat(p.config)).mode & 0o777;
      await atomicWrite(p.config, applied.text, mode);
    } catch (e) {
      for (const [file, backup] of backups) {
        if (backup === null) await rm(file, { force: true }); else await atomicWrite(file, backup.contents, backup.mode);
      }
      throw e;
    }
  });
  return { home, credentialHome: dirname(resolve(opperConfigPath())), keyName, baseUrl, model, projectUuid, ...(proxy ? {proxyStateDir: proxy.stateDir} : {}) };
}

function customHome(settings: ConfiguredDesktop): boolean { return settings.home !== resolve(join(homedir(), ".codex")); }
function shellQuote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }
function launchCommand(settings: ConfiguredDesktop): string {
  if (platform() === "win32") {
    const environment = [`Remove-Item Env:OPPER_API_KEY -ErrorAction SilentlyContinue`, `$env:OPPER_HOME=${powerShellLiteral(settings.credentialHome)}`, `$env:OPPER_BASE_URL=${powerShellLiteral(settings.baseUrl)}`];
    if (process.env.CODEX_ELECTRON_USER_DATA_PATH) environment.push(`$env:CODEX_ELECTRON_USER_DATA_PATH=${powerShellLiteral(resolve(process.env.CODEX_ELECTRON_USER_DATA_PATH))}`);
    const args = ["--key", settings.keyName, "launch", "codex-desktop", "--model", settings.model, "--codex-home", settings.home];
    if (settings.projectUuid) args.push("--project-uuid", settings.projectUuid);
    if (settings.proxyStateDir) args.push("--proxy", "--state-dir", settings.proxyStateDir);
    return [...environment, `& opper.cmd ${args.map(powerShellLiteral).join(" ")}`].join("; ");
  }
  const args = ["env", "-u", "OPPER_API_KEY", `OPPER_HOME=${settings.credentialHome}`, `OPPER_BASE_URL=${settings.baseUrl}`];
  if (process.env.CODEX_ELECTRON_USER_DATA_PATH) args.push(`CODEX_ELECTRON_USER_DATA_PATH=${resolve(process.env.CODEX_ELECTRON_USER_DATA_PATH)}`);
  args.push("opper", "--key", settings.keyName, "launch", "codex-desktop", "--model", settings.model, "--codex-home", settings.home);
  if (settings.projectUuid) args.push("--project-uuid", settings.projectUuid);
  if (settings.proxyStateDir) args.push("--proxy", "--state-dir", settings.proxyStateDir);
  return args.map(shellQuote).join(" ");
}
function reopenHint(settings: ConfiguredDesktop): string {
  if (platform() === "win32") return `Quit the app, then run this PowerShell command to use the configured Codex home:\n${launchCommand(settings)}\nOrdinary Start menu launches use %USERPROFILE%\\.codex. Existing tasks keep their provider.`;
  return customHome(settings)
    ? `Quit the app, then use the same Codex home with this command:\n${launchCommand(settings)}\nOrdinary Finder launches use ~/.codex, not this custom home. Existing tasks keep their provider.`
    : "Quit and reopen the app to use Opper for new local Codex tasks. Existing tasks keep their provider.";
}
async function configure(opts: ConfigureOptions): Promise<void> {
  const settings = await setup(opts);
  if (customHome(settings)) console.log(`Configured only ${settings.home}. To use the same Codex home, run:\n${launchCommand(settings)}\n${platform() === "win32" ? "Ordinary Start menu launches use %USERPROFILE%\\.codex." : "Ordinary Finder launches use ~/.codex."} The command above runs opper launch codex-desktop with your selected key and model.`);
}

async function unconfigure(opts?: UnconfigureOptions): Promise<void> {
  const home = codexHome(opts?.codexHome);
  const p = paths(home);
  if (!existsSync(p.state)) return;
  await locked(home, async () => {
    await checkConfigPaths(home);
    const state = await readState(p.state);
    if (!state) return;
    const existing = await readOptional(p.config);
    if (existing !== null) {
      const restored = removeDesktopConfig(existing, state.config);
      if (await readOptional(p.config) !== existing) throw new OpperError("AGENT_CONFIG_CONFLICT", "Codex settings changed during removal. Retry to preserve those edits.");
      if (!state.configExisted && restored.trim() === "") await rm(p.config);
      else await atomicWrite(p.config, restored, (await stat(p.config)).mode & 0o777);
    }
    for (const file of [p.auth, p.catalog, p.state, ...(state.bundledRuntime ? [p.runtime, p.runtimeLicense] : [])]) await rm(file, { force: true });
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
    if (!state || !text || !existsSync(p.auth) || (state.config.settings.model_catalog_json !== undefined && !existsSync(p.catalog))) return false;
    const config = readDesktopConfig(text);
    const provider = (config.model_providers as Record<string, Record<string, unknown>> | undefined)?.[DESKTOP_PROVIDER];
    return config.model_provider === DESKTOP_PROVIDER && (state.config.settings.model_catalog_json === undefined
      ? config.model_catalog_json === undefined && provider?.model_catalog_url === state.config.settings.provider.model_catalog_url
      : config.model_catalog_json === p.catalog);
  } catch { return false; }
}

async function spawn(args: string[], routing: OpperRouting, opts?: SpawnOptions): Promise<number> {
  if (args.length) throw new OpperError("INVALID_ARGUMENT", "codex-desktop does not accept passthrough arguments.");
  const app = requireApp();
  const baseUrl = routing.apiBaseUrl ?? routing.baseUrl.replace(/\/v3\/(?:compat|session\/[^/]+)(?:\/.*)?$/, "");
  const settings = await setup({ apiKey: routing.apiKey, keyName: routing.keyName ?? "default", baseUrl, ...(routing.modelOverride ? { model: routing.modelOverride } : {}), ...(routing.modelKinds ? { modelKinds: routing.modelKinds } : {}), ...(routing.projectUuid ? { projectUuid: routing.projectUuid } : {}), ...(routing.desktopProxy ? { desktopProxy: routing.desktopProxy } : {}), ...(opts?.codexHome !== undefined ? { codexHome: opts.codexHome } : {}) }, routing.model);
  const userData = process.env.CODEX_ELECTRON_USER_DATA_PATH;
  if (platform() === "win32") {
    const processState = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; (Get-Process -Name Codex,ChatGPT -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).Id"], {timeout: 5_000});
    if (processState.code !== 0) throw new OpperError("AGENT_CONFIG_CONFLICT", "Opper is configured, but the app's running state could not be checked.", reopenHint(settings));
    if (processState.stdout.trim() && !userData) throw new OpperError("AGENT_CONFIG_CONFLICT", "Opper is configured, but the Codex/ChatGPT app is already running.", reopenHint(settings));
    if (!app.executable) throw new OpperError("AGENT_NOT_FOUND", "The registered Codex desktop executable is unavailable.", reopenHint(settings));
    const environment = [`$ErrorActionPreference = 'Stop'`, `$env:CODEX_HOME=${powerShellLiteral(settings.home)}`];
    let argumentsList = "";
    if (userData) {
      const profile = resolve(userData);
      environment.push(`$env:CODEX_ELECTRON_USER_DATA_PATH=${powerShellLiteral(profile)}`);
      // Start-Process joins ArgumentList into a Windows command line: keep the whole
      // profile argument quoted so spaces in the directory survive that conversion.
      argumentsList = ` -ArgumentList ${powerShellLiteral(`"--user-data-dir=${profile}"`)}`;
    }
    const script = [...environment, `Start-Process -FilePath ${powerShellLiteral(app.executable)}${argumentsList}`].join("; ");
    const opened = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {timeout: 5_000});
    if (opened.code !== 0) throw new OpperError("AGENT_NOT_FOUND", "Opper is configured, but the Codex/ChatGPT app could not be opened.", reopenHint(settings));
    console.log("Opened Codex/ChatGPT with Opper for new local Codex tasks.");
    return 0;
  }
  const executable = run("/usr/bin/plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", join(app.app, "Contents", "Info.plist")]);
  const binary = join(app.app, "Contents", "MacOS", executable.stdout.trim() || "ChatGPT");
  const processes = run("pgrep", ["-f", `^${binary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([[:space:]]|$)`]);
  if (processes.code !== 0 && processes.code !== 1) throw new OpperError("AGENT_CONFIG_CONFLICT", "Opper is configured, but the app's running state could not be checked.", reopenHint(settings));
  const running = processes.code === 0;
  if (running && !userData) {
    throw new OpperError("AGENT_CONFIG_CONFLICT", "Opper is configured, but the Codex/ChatGPT app is already running.", reopenHint(settings));
  }
  const openArgs = ["-a", app.app, "--env", `CODEX_HOME=${settings.home}`];
  if (userData) openArgs.push("-n", "--env", `CODEX_ELECTRON_USER_DATA_PATH=${resolve(userData)}`, "--args", `--user-data-dir=${resolve(userData)}`);
  const opened = run("open", openArgs);
  if (opened.code !== 0) throw new OpperError("AGENT_NOT_FOUND", "Opper is configured, but the Codex/ChatGPT app could not be opened.", reopenHint(settings));
  console.log("Opened Codex/ChatGPT with Opper for new local Codex tasks.");
  return 0;
}

export const codexDesktop: AgentAdapter = {
  name: "codex-desktop", displayName: "Codex Desktop (ChatGPT)", docsUrl: "https://chatgpt.com/download",
  launchesInBackground: true,
  async detect() { const app = findApp(); return { installed: app !== null, ...(app ? { version: app.version } : {}), configPath: paths().config }; },
  isConfigured,
  configure,
  unconfigure,
  spawn,
};
