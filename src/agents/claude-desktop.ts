import { existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { OpperError } from "../errors.js";
import { OPPER_HOST, OPPER_COMPAT_URL } from "../config/endpoints.js";
import {
  CLAUDE_DESKTOP_MODEL_IDS,
  DEFAULT_MODELS,
  isClaudeDesktopModelId,
} from "../config/models.js";
import { run } from "../util/run.js";
import { validateModelKinds } from "../setup/model-catalog.js";
import { windowsDesktopApps } from "../util/windows-desktop.js";
import type {
  AgentAdapter,
  ConfigureOptions,
  DetectResult,
  OpperRouting,
} from "./types.js";

function darwinAppCandidates(): string[] {
  return [
    "/Applications/Claude.app",
    join(homedir(), "Applications", "Claude.app"),
  ];
}

function windowsLocalAppData(): string | null {
  const local = (process.env.LOCALAPPDATA ?? "").trim();
  if (local) return local;
  const profile = (process.env.USERPROFILE ?? "").trim();
  if (profile) return join(profile, "AppData", "Local");
  try {
    return join(homedir(), "AppData", "Local");
  } catch {
    return null;
  }
}

function windowsGlobCandidates(local: string): string[] {
  const parents = [
    join(local, "AnthropicClaude"),
    join(local, "Programs", "Claude"),
    join(local, "Programs", "Claude Desktop"),
  ];
  const out: string[] = [];
  for (const parent of parents) {
    let entries: string[];
    try {
      entries = readdirSync(parent);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith("app-")) {
        out.push(join(parent, entry, "Claude.exe"));
      }
    }
  }
  return out;
}

function windowsAppCandidates(): string[] {
  const local = windowsLocalAppData();
  if (!local) return [];
  const fixed = [
    join(local, "Programs", "Claude", "Claude.exe"),
    join(local, "Programs", "Claude Desktop", "Claude.exe"),
    join(local, "Claude", "Claude.exe"),
    join(local, "Claude Nest", "Claude.exe"),
    join(local, "Claude Desktop", "Claude.exe"),
    join(local, "AnthropicClaude", "Claude.exe"),
  ];
  return dedupePaths([...fixed, ...windowsGlobCandidates(local)]);
}

function appCandidates(): string[] {
  switch (platform()) {
    case "darwin":
      return darwinAppCandidates();
    case "win32": {
      const legacy = windowsAppCandidates();
      if (legacy.some((candidate) => existsSync(candidate))) return legacy;
      return [...legacy, ...windowsDesktopApps("Claude").map((app) => app.executable)];
    }
    default:
      return [];
  }
}

const OPPER_PROFILE_ID = "727f05c8-a429-43cc-b1c6-36d8883d98b8";
const OPPER_PROFILE_NAME = "Opper";
const CATALOG_HEADERS = ["X-Opper-Model-Catalog", "X-Opper-Catalog-Model-Kinds", "X-Opper-Catalog-Selected-Model"] as const;
const CATALOG_PROFILE = "claude-desktop";

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function catalogHeaders(profile: JsonObject): Record<string, string> {
  if (!object(profile.inferenceCustomHeaders)) return {};
  const headers: Record<string, string> = {};
  for (const name of CATALOG_HEADERS) {
    const entry = Object.entries(profile.inferenceCustomHeaders).find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (typeof entry?.[1] === "string") headers[name] = entry[1];
  }
  return headers;
}

function nativeProfile(profile: JsonObject): boolean {
  const headers = catalogHeaders(profile);
  return profile.modelDiscoveryEnabled === true && profile.inferenceModels === undefined &&
    headers[CATALOG_HEADERS[0]] === CATALOG_PROFILE &&
    ["pools,routes", "all"].includes(headers[CATALOG_HEADERS[1]] ?? "") &&
    isClaudeDesktopModelId(headers[CATALOG_HEADERS[2]] ?? "");
}

function legacyModels(profile: JsonObject): JsonObject[] {
  if (!Array.isArray(profile.inferenceModels)) return [];
  const seen = new Set<string>();
  return profile.inferenceModels.flatMap(entry => {
    const model = typeof entry === "string" ? {name: entry} : entry;
    if (!object(model) || typeof model.name !== "string" || !isClaudeDesktopModelId(model.name) || seen.has(model.name)) return [];
    seen.add(model.name);
    return [model];
  });
}

function customizedModels(profile: JsonObject): boolean {
  return legacyModels(profile).some(model => Object.keys(model).some(key => key !== "name"));
}

function hasNativeDiscoveryVersion(): boolean {
  const candidate = appCandidates().find(path => existsSync(path));
  if (!candidate) return false;
  const result = platform() === "darwin"
    ? run("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(candidate, "Contents", "Info.plist")], {timeout: 5_000})
    : run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Item -LiteralPath '${candidate.replace(/'/g, "''")}').VersionInfo.ProductVersion`], {timeout: 5_000});
  const match = result?.code === 0 ? result.stdout.trim().match(/^(\d+)\.(\d+)\.(\d+)/) : null;
  return Boolean(match && (Number(match[1]) > 1 || (Number(match[1]) === 1 && Number(match[2]) >= 8089)));
}

async function probeNativeCatalog(
  baseUrl: string, apiKey: string, projectUuid: string | undefined, headers: Record<string, string>, selected: string,
): Promise<boolean> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 3; page++) {
    const url = new URL(`${baseUrl.replace(/\/+$/, "")}/v3/compat/v1/models`);
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("after_id", cursor);
    let response: Response;
    try {
      response = await fetch(url.toString(), {headers: {Authorization: `Bearer ${apiKey}`, ...(projectUuid ? {"X-Opper-Project": projectUuid} : {}), ...headers},
        redirect: "error", signal: AbortSignal.timeout(10_000)});
    } catch (error) {
      throw new OpperError("NETWORK_ERROR", `Claude Desktop model discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new OpperError(response.status === 401 ? "AUTH_EXPIRED" : "API_ERROR", `Claude Desktop model discovery returned HTTP ${response.status}.`);
    // Older gateways ignore presentation headers. Verify the selected model
    // against their full compatibility endpoint, then retain the explicit list.
    if (response.headers.get(CATALOG_HEADERS[0]) !== CATALOG_PROFILE) {
      const legacyUrl = `${baseUrl.replace(/\/+$/, "")}/v3/compat/models`;
      let legacy: Response;
      try { legacy = await fetch(legacyUrl, {headers: {Authorization: `Bearer ${apiKey}`, ...headers, ...(projectUuid ? {"X-Opper-Project": projectUuid} : {})}, redirect: "error", signal: AbortSignal.timeout(10_000)}); }
      catch { throw new OpperError("NETWORK_ERROR", "Cannot verify the selected Claude Desktop model against this gateway."); }
      if (!legacy.ok) throw new OpperError(legacy.status === 401 ? "AUTH_EXPIRED" : "API_ERROR", `Claude Desktop model discovery returned HTTP ${legacy.status}.`);
      const body: unknown = await legacy.json();
      if (!object(body) || !Array.isArray(body.data) || !body.data.some(entry => object(entry) && entry.id === selected)) {
        throw new OpperError("API_ERROR", "The selected model is not in this credential's allowed Claude Desktop catalog.");
      }
      return false;
    }
    let body: unknown;
    try { body = await response.json(); } catch { throw new OpperError("API_ERROR", "Invalid Claude Desktop discovery response."); }
    if (!object(body) || typeof body.has_more !== "boolean" || !Array.isArray(body.data) || body.data.some(entry =>
      !object(entry) || entry.type !== "model" || typeof entry.id !== "string" || !isClaudeDesktopModelId(entry.id) ||
      typeof entry.display_name !== "string" || !entry.display_name.trim() || typeof entry.created_at !== "string" || !Number.isFinite(Date.parse(entry.created_at)))) {
      throw new OpperError("API_ERROR", "The Claude Desktop discovery profile returned unsupported model IDs.");
    }
    for (const entry of body.data as {id: string}[]) seen.add(entry.id);
    if (body.has_more !== true) break;
    if (typeof body.last_id !== "string" || !body.last_id || body.last_id === cursor || !body.data.length || !object(body.data.at(-1)) || body.data.at(-1)!.id !== body.last_id) throw new OpperError("API_ERROR", "Invalid Claude Desktop discovery cursor.");
    cursor = body.last_id;
  }
  if (!seen.has(selected)) throw new OpperError("API_ERROR", "The selected model is not in this credential's allowed Claude Desktop catalog.");
  return true;
}

const QUIT_TIMEOUT_MS = 5_000;
const QUIT_POLL_INTERVAL_MS = 200;

interface ThirdPartyPaths {
  desktopConfig: string;
  meta: string;
  profile: string;
  ownership: string;
}

interface ConfigTargets {
  normalConfigs: string[];
  thirdPartyProfiles: ThirdPartyPaths[];
}

function darwinProfileRoots(): { normal: string[]; thirdParty: string[] } {
  const base = join(homedir(), "Library", "Application Support");
  return {
    normal: [join(base, "Claude")],
    thirdParty: [join(base, "Claude-3p")],
  };
}

function windowsProfileRoots(): { normal: string[]; thirdParty: string[] } {
  const local = windowsLocalAppData();
  if (!local) return { normal: [], thirdParty: [] };
  return {
    normal: [join(local, "Claude"), join(local, "Claude Nest")],
    thirdParty: [join(local, "Claude-3p"), join(local, "Claude Nest-3p")],
  };
}

function profileRoots(): { normal: string[]; thirdParty: string[] } {
  switch (platform()) {
    case "darwin":
      return darwinProfileRoots();
    case "win32":
      return windowsProfileRoots();
    default:
      return { normal: [], thirdParty: [] };
  }
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function targetPaths(): ConfigTargets {
  const { normal, thirdParty } = profileRoots();
  return {
    normalConfigs: dedupePaths(normal).map((root) =>
      join(root, "claude_desktop_config.json"),
    ),
    thirdPartyProfiles: dedupePaths(thirdParty).map((root) => ({
      desktopConfig: join(root, "claude_desktop_config.json"),
      meta: join(root, "configLibrary", "_meta.json"),
      profile: join(root, "configLibrary", `${OPPER_PROFILE_ID}.json`),
      ownership: join(root, ".opper-gateway-state.json"),
    })),
  };
}

type JsonObject = Record<string, unknown>;

async function readJsonAllowMissing(path: string): Promise<JsonObject> {
  try {
    const data = await readFile(path, "utf8");
    const parsed = JSON.parse(data) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
    throw new OpperError("AGENT_CONFIG_CONFLICT", `Cannot safely edit ${path}: expected a JSON object. Existing configuration was preserved.`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function readProfileSnapshot(path: string): Promise<{text: string | null; value: JsonObject}> {
  try {
    const text = await readFile(path, "utf8");
    const value: unknown = JSON.parse(text);
    if (!object(value)) throw new OpperError("AGENT_CONFIG_CONFLICT", `Cannot safely edit ${path}: expected a JSON object.`);
    return {text, value};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {text: null, value: {}};
    throw error;
  }
}

async function writeJson(path: string, data: JsonObject): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // 0o600 because the gateway profile JSON stores inferenceGatewayApiKey;
  // applied uniformly so we don't have to reason about which file is which.
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

async function readJsonOrNull(path: string): Promise<JsonObject | null> {
  try {
    const data = await readFile(path, "utf8");
    const parsed = JSON.parse(data) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
    return null;
  } catch {
    return null;
  }
}

async function deploymentModeIsThirdParty(path: string): Promise<boolean> {
  const cfg = await readJsonOrNull(path);
  return cfg?.deploymentMode === "3p";
}

function isLocalGatewayUrl(value: string): boolean {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/v3\/compat\/?$/.exec(value);
  return !!match && Number(match[1]) <= 65535;
}

function gatewayFingerprint(profile: JsonObject, version = 3, projectHeader?: string): string {
  const fields = ["inferenceProvider", "inferenceGatewayBaseUrl", "inferenceGatewayApiKey", "inferenceGatewayAuthScheme", "disableDeploymentModeChooser", "inferenceModels"];
  const values = fields.map((field) => profile[field]);
  if (version >= 2) values.push(profile.modelDiscoveryEnabled, catalogHeaders(profile));
  if (version >= 3) values.push(projectHeader, projectHeader && object(profile.inferenceCustomHeaders) ? profile.inferenceCustomHeaders[projectHeader] : undefined);
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

async function profileHasManagedGateway(target: ThirdPartyPaths, profile: JsonObject): Promise<boolean> {
  if (profile.inferenceProvider !== "gateway") return false;
  const ownership = await readJsonOrNull(target.ownership);
  if (ownership) return [1, 2, 3].includes(ownership.version as number) && ownership.fingerprint === gatewayFingerprint(profile, ownership.version as number, typeof ownership.projectHeader === "string" ? ownership.projectHeader : undefined);
  // Older direct integrations predate the ownership record. A loopback URL
  // alone never proves ownership of a customer's local gateway.
  if (existsSync(target.ownership)) return false;
  const url = typeof profile.inferenceGatewayBaseUrl === "string"
    ? profile.inferenceGatewayBaseUrl.replace(/\/+$/, "")
    : "";
  return url === OPPER_COMPAT_URL.replace(/\/+$/, "");
}

function gatewayCredentials(apiKey: string, proxy?: ConfigureOptions["desktopProxy"], apiBaseUrl = OPPER_HOST): {url: string; key: string} {
  if (!proxy) return {url: `${apiBaseUrl.replace(/\/+$/, "")}/v3/compat`, key: apiKey};
  const url = `${proxy.baseUrl.replace(/\/+$/, "")}/v3/compat`;
  if (!isLocalGatewayUrl(url) || typeof proxy.token !== "string" || !proxy.token.trim() || /[\r\n]/.test(proxy.token)) {
    throw new OpperError("INVALID_ARGUMENT", "Claude Desktop proxy requires a loopback HTTP endpoint and local authentication token.");
  }
  return {url, key: proxy.token};
}

async function profileIsOpperGateway(target: ThirdPartyPaths): Promise<boolean> {
  const meta = await readJsonOrNull(target.meta);
  if (meta?.appliedId !== OPPER_PROFILE_ID) return false;
  const profile = await readJsonOrNull(target.profile);
  if (!profile) return false;
  if (!(await profileHasManagedGateway(target, profile))) return false;
  const key = typeof profile.inferenceGatewayApiKey === "string"
    ? profile.inferenceGatewayApiKey.trim()
    : "";
  if (key.length === 0) return false;
  if (nativeProfile(profile)) return true;
  if (!Array.isArray(profile.inferenceModels) || !profile.inferenceModels.length) return false;
  const models = legacyModels(profile);
  const names = models.map(model => model.name as string);
  return models.length === profile.inferenceModels.length && new Set(names).size === names.length;
}

async function writeDeploymentMode(path: string, mode: "1p" | "3p"): Promise<void> {
  const cfg = await readJsonAllowMissing(path);
  cfg.deploymentMode = mode;
  await writeJson(path, cfg);
}

async function writeMetaWithOpperEntry(path: string): Promise<void> {
  const meta = await readJsonAllowMissing(path);
  meta.appliedId = OPPER_PROFILE_ID;
  const entries = Array.isArray(meta.entries) ? meta.entries : [];
  const filtered = entries.filter((e: unknown) => {
    const obj = e as { id?: unknown } | null;
    return !(obj && typeof obj === "object" && obj.id === OPPER_PROFILE_ID);
  });
  filtered.push({ id: OPPER_PROFILE_ID, name: OPPER_PROFILE_NAME });
  meta.entries = filtered;
  await writeJson(path, meta);
}

async function writeGatewayProfile(
  target: ThirdPartyPaths, apiKey: string, primaryModel: string, baseUrl: string,
  prior: JsonObject, nativeHeaders?: Record<string, string>, project?: {name: string; value: string; owned: boolean},
): Promise<void> {
  const cfg = {...prior};
  cfg.inferenceProvider = "gateway";
  cfg.inferenceGatewayBaseUrl = baseUrl;
  cfg.inferenceGatewayApiKey = apiKey;
  cfg.inferenceGatewayAuthScheme = "bearer";
  cfg.disableDeploymentModeChooser = true;
  if (nativeHeaders) {
    cfg.modelDiscoveryEnabled = true;
    delete cfg.inferenceModels;
    const unrelated = object(prior.inferenceCustomHeaders) ? Object.fromEntries(Object.entries(prior.inferenceCustomHeaders)
      .filter(([key]) => !CATALOG_HEADERS.some(name => name.toLowerCase() === key.toLowerCase()))) : {};
    cfg.inferenceCustomHeaders = {...unrelated, ...nativeHeaders};
  } else {
    const existing = legacyModels(prior);
    // Retain saved selections and per-entry preferences on old/unknown apps or
    // servers. A fresh legacy setup keeps the historical curated fallback.
    const models = existing.length ? existing : CLAUDE_DESKTOP_MODEL_IDS.map(name => ({name}));
    const selected = models.find(model => model.name === primaryModel) ?? {name: primaryModel};
    cfg.inferenceModels = [selected, ...models.filter(model => model.name !== primaryModel)];
  }
  const custom = object(cfg.inferenceCustomHeaders) ? Object.fromEntries(Object.entries(cfg.inferenceCustomHeaders).filter(([name]) => name.toLowerCase() !== "x-opper-project")) : {};
  if (project) custom[project.name] = project.value;
  if (Object.keys(custom).length) cfg.inferenceCustomHeaders = custom;
  else delete cfg.inferenceCustomHeaders;
  const ownedProject = project?.owned ? project.name : undefined;
  await writeJson(target.profile, cfg);
  await writeJson(target.ownership, {version: 3, ...(ownedProject ? {projectHeader: ownedProject} : {}), fingerprint: gatewayFingerprint(cfg, 3, ownedProject)});
}

async function detect(): Promise<DetectResult> {
  for (const candidate of appCandidates()) {
    if (existsSync(candidate)) return { installed: true };
  }
  return { installed: false };
}

async function isConfigured(): Promise<boolean> {
  const targets = targetPaths();
  if (targets.normalConfigs.length === 0 || targets.thirdPartyProfiles.length === 0) {
    return false;
  }
  for (const path of targets.normalConfigs) {
    if (!(await deploymentModeIsThirdParty(path))) return false;
  }
  for (const target of targets.thirdPartyProfiles) {
    if (!(await deploymentModeIsThirdParty(target.desktopConfig))) return false;
    if (!(await profileIsOpperGateway(target))) return false;
  }
  return true;
}

async function applyOpperProfile(
  apiKey: string, primaryModel: string, proxy?: ConfigureOptions["desktopProxy"],
  options: {apiBaseUrl?: string; projectUuid?: string | undefined; modelKinds?: ConfigureOptions["modelKinds"]; explicitModel?: string | undefined} = {},
): Promise<void> {
  const apiBaseUrl = options.apiBaseUrl ?? OPPER_HOST;
  const gateway = gatewayCredentials(apiKey, proxy, apiBaseUrl);
  const targets = targetPaths();
  const nativeVersion = hasNativeDiscoveryVersion();
  if (options.projectUuid && !proxy && !nativeVersion) throw new OpperError("INVALID_ARGUMENT", "Claude Desktop project headers require a supported installed app version.");
  // Prepare and validate every catalog before the first config/meta write.
  const profiles = await Promise.all(targets.thirdPartyProfiles.map(async target => {
    const snapshot = await readProfileSnapshot(target.profile);
    const prior = snapshot.value;
    const previousHeaders = catalogHeaders(prior);
    const selected = options.explicitModel ?? (typeof legacyModels(prior)[0]?.name === "string" ? legacyModels(prior)[0]!.name as string : previousHeaders[CATALOG_HEADERS[2]]) ?? primaryModel;
    if (!isClaudeDesktopModelId(selected)) throw new OpperError("INVALID_ARGUMENT", `Claude Desktop does not support model "${selected}".`);
    // A former selected deployment may be saved by an open tab/session. A
    // selected-model change cannot hide it from subsequent native refreshes.
    const retainFullCatalog = nativeProfile(prior) && (previousHeaders[CATALOG_HEADERS[1]] === "all" || previousHeaders[CATALOG_HEADERS[2]] !== selected);
    const modelKinds = retainFullCatalog || legacyModels(prior).length ? "all" : options.modelKinds ?? previousHeaders[CATALOG_HEADERS[1]] ?? "pools,routes";
    validateModelKinds(modelKinds);
    const custom = prior.inferenceCustomHeaders;
    if (custom !== undefined && (!object(custom) || Object.values(custom).some(value => typeof value !== "string"))) {
      throw new OpperError("AGENT_CONFIG_CONFLICT", "Claude Desktop custom headers must contain string values. Existing configuration was preserved.");
    }
    const customEntries = Object.entries(custom ?? {});
    if (customEntries.some(([name]) => ["authorization", "proxy-authorization", "x-api-key", "api-key", "x-goog-api-key"].includes(name.toLowerCase()))) {
      throw new OpperError("AGENT_CONFIG_CONFLICT", "Claude Desktop has conflicting authentication headers. Existing configuration was preserved.");
    }
    const projects = customEntries.filter(([name]) => name.toLowerCase() === "x-opper-project");
    if (projects.length > 1) throw new OpperError("AGENT_CONFIG_CONFLICT", "Claude Desktop has duplicate project headers. Existing configuration was preserved.");
    const previousOwnership = await readJsonOrNull(target.ownership);
    const priorProjectName = projects[0]?.[0];
    const priorProjectValue = projects[0]?.[1] as string | undefined;
    const ownedProject = Boolean(priorProjectName && previousOwnership?.version === 3 && previousOwnership.projectHeader === priorProjectName &&
      previousOwnership.fingerprint === gatewayFingerprint(prior, 3, priorProjectName));
    if (priorProjectValue && ((options.projectUuid && priorProjectValue !== options.projectUuid) || (proxy && !options.projectUuid)) && !ownedProject) {
      throw new OpperError("AGENT_CONFIG_CONFLICT", "Claude Desktop has a conflicting project header. Existing configuration was preserved.");
    }
    // The proxy binds its project itself; no project is added to its client
    // profile. A matching pre-existing user header remains user-owned.
    const projectValue = proxy ? (priorProjectValue ? options.projectUuid : undefined) : options.projectUuid ?? priorProjectValue;
    const project = projectValue ? {name: priorProjectName ?? "X-Opper-Project", value: projectValue, owned: ownedProject || (!proxy && !priorProjectName)} : undefined;
    const probeProject = proxy ? options.projectUuid : projectValue;
    const headers = {[CATALOG_HEADERS[0]]: CATALOG_PROFILE, [CATALOG_HEADERS[1]]: modelKinds, [CATALOG_HEADERS[2]]: selected};
    const probeHeaders = {...Object.fromEntries(customEntries.filter(([name]) => !CATALOG_HEADERS.some(key => key.toLowerCase() === name.toLowerCase()) && name.toLowerCase() !== "x-opper-project")), ...headers} as Record<string, string>;
    if (!nativeVersion && nativeProfile(prior)) {
      throw new OpperError("AGENT_CONFIG_CONFLICT", "Cannot verify native model discovery support in this Claude Desktop installation. Existing configuration was preserved.");
    }
    const supported = nativeVersion && await probeNativeCatalog(apiBaseUrl, apiKey, probeProject, probeHeaders, selected);
    if (!supported && nativeProfile(prior)) throw new OpperError("API_ERROR", "This gateway no longer acknowledges the native Claude Desktop catalog. Existing configuration was preserved.");
    // A native catalog would drop user labels, effort caps and other per-model
    // preferences. Keep customized lineups and explicit discovery opt-outs.
    const mayMigrate = !customizedModels(prior) && prior.modelDiscoveryEnabled !== false;
    return {target, prior, selected, headers: supported && mayMigrate ? headers : undefined, project, priorText: snapshot.text};
  }));
  for (const profile of profiles) {
    if ((await readProfileSnapshot(profile.target.profile)).text !== profile.priorText) {
      throw new OpperError("AGENT_CONFIG_CONFLICT", "Claude Desktop settings changed during model discovery. Retry to preserve those edits.");
    }
  }
  for (const path of targets.normalConfigs) await writeDeploymentMode(path, "3p");
  for (const {target, prior, selected, headers, project} of profiles) {
    await writeDeploymentMode(target.desktopConfig, "3p");
    await writeMetaWithOpperEntry(target.meta);
    await writeGatewayProfile(target, gateway.key, selected, gateway.url, prior, headers, project);
  }
}

async function configure(opts: ConfigureOptions): Promise<void> {
  if (!opts.apiKey && !opts.desktopProxy) {
    throw new OpperError(
      "AUTH_REQUIRED",
      "Claude Desktop configuration needs an Opper API key.",
      "Run `opper login` first, or set OPPER_API_KEY.",
    );
  }
  await applyOpperProfile(opts.apiKey ?? "", DEFAULT_MODELS.opus, opts.desktopProxy, {apiBaseUrl: opts.baseUrl ?? OPPER_HOST, projectUuid: opts.projectUuid, modelKinds: opts.modelKinds, explicitModel: opts.model});
}

async function clearOpperEntryFromMeta(path: string): Promise<void> {
  const meta = await readJsonOrNull(path);
  if (!meta) return;
  let changed = false;
  if (meta.appliedId === OPPER_PROFILE_ID) {
    delete meta.appliedId;
    changed = true;
  }
  if (Array.isArray(meta.entries)) {
    const filtered = meta.entries.filter((e: unknown) => {
      const obj = e as { id?: unknown } | null;
      return !(obj && typeof obj === "object" && obj.id === OPPER_PROFILE_ID);
    });
    if (filtered.length !== meta.entries.length) {
      meta.entries = filtered;
      changed = true;
    }
  }
  if (changed) await writeJson(path, meta);
}

async function blankGatewayProfile(target: ThirdPartyPaths): Promise<void> {
  const path = target.profile;
  const cfg = await readJsonOrNull(path);
  if (!cfg) return;
  delete cfg.inferenceProvider;
  delete cfg.inferenceGatewayBaseUrl;
  delete cfg.inferenceGatewayApiKey;
  delete cfg.inferenceGatewayAuthScheme;
  delete cfg.inferenceModels;
  if (nativeProfile(cfg)) {
    delete cfg.modelDiscoveryEnabled;
    if (object(cfg.inferenceCustomHeaders)) {
      const remaining = Object.fromEntries(Object.entries(cfg.inferenceCustomHeaders).filter(([key]) => !CATALOG_HEADERS.some(name => name.toLowerCase() === key.toLowerCase())));
      if (Object.keys(remaining).length) cfg.inferenceCustomHeaders = remaining;
      else delete cfg.inferenceCustomHeaders;
    }
  }
  const ownership = await readJsonOrNull(target.ownership);
  if (ownership?.version === 3 && typeof ownership.projectHeader === "string" && object(cfg.inferenceCustomHeaders)) {
    delete cfg.inferenceCustomHeaders[ownership.projectHeader];
    if (!Object.keys(cfg.inferenceCustomHeaders).length) delete cfg.inferenceCustomHeaders;
  }
  cfg.disableDeploymentModeChooser = false;
  await writeJson(path, cfg);
}

async function maybeFlipToFirstParty(path: string): Promise<void> {
  const cfg = await readJsonOrNull(path);
  if (!cfg) return;
  cfg.deploymentMode = "1p";
  await writeJson(path, cfg);
}

async function unconfigure(): Promise<void> {
  const targets = targetPaths();
  let activeOpperProfile = false;
  for (const target of targets.thirdPartyProfiles) {
    const profile = await readJsonOrNull(target.profile);
    if (!profile || !(await profileHasManagedGateway(target, profile))) continue;
    const meta = await readJsonOrNull(target.meta);
    if (meta?.appliedId === OPPER_PROFILE_ID) {
      activeOpperProfile = true;
      await maybeFlipToFirstParty(target.desktopConfig);
    }
    await clearOpperEntryFromMeta(target.meta);
    await blankGatewayProfile(target);
    await rm(target.ownership, {force: true});
  }
  if (activeOpperProfile) {
    for (const path of targets.normalConfigs) await maybeFlipToFirstParty(path);
  }
}

async function install(): Promise<void> {
  throw new OpperError(
    "AGENT_NOT_FOUND",
    "Claude Desktop must be installed manually.",
    "Download Claude Desktop from https://claude.ai/download.",
  );
}

function isClaudeRunning(): boolean {
  switch (platform()) {
    case "darwin": {
      const result = run("pgrep", ["-f", "Claude.app/Contents/MacOS/Claude"]);
      return result.code === 0 && result.stdout.trim().length > 0;
    }
    case "win32": {
      const result = run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-Process claude -ErrorAction SilentlyContinue | " +
          "Where-Object { $_.MainWindowHandle -ne 0 } | " +
          "Select-Object -First 1).Id",
      ], {timeout: 5_000});
      if (result.code !== 0) throw new OpperError("AGENT_CONFIG_CONFLICT", "Unable to check whether Claude Desktop is running.", "Open Claude Desktop manually after checking your Windows processes.");
      return result.code === 0 && result.stdout.trim().length > 0;
    }
    default:
      return false;
  }
}

function quitClaude(): void {
  switch (platform()) {
    case "darwin": {
      const result = run("osascript", ["-e", 'tell application "Claude" to quit']);
      if (result.code !== 0 && /Not authorized/i.test(result.stderr)) {
        throw new OpperError(
          "AGENT_CONFIG_CONFLICT",
          "macOS denied automation permission for Claude Desktop.",
          "Grant access in System Settings → Privacy & Security → Automation, then re-run `opper launch claude-desktop`.",
        );
      }
      return;
    }
    case "win32":
      run("powershell.exe", [
        "-NoProfile",
        "-Command",
        "Get-Process claude -ErrorAction SilentlyContinue | " +
          "Where-Object { $_.MainWindowHandle -ne 0 } | " +
          "ForEach-Object { [void]$_.CloseMainWindow() }",
      ], {timeout: 5_000});
      return;
  }
}

async function waitForClaudeExit(): Promise<boolean> {
  const deadline = Date.now() + QUIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isClaudeRunning()) return true;
    await new Promise((r) => setTimeout(r, QUIT_POLL_INTERVAL_MS));
  }
  return !isClaudeRunning();
}

function openClaude(): void {
  switch (platform()) {
    case "darwin": {
      const result = run("open", ["-a", "Claude"]);
      if (result.code !== 0) {
        throw new OpperError(
          "AGENT_NOT_FOUND",
          "Failed to open Claude Desktop.",
          (result.stderr.trim() || "`open -a Claude` exited non-zero.") +
            " Open Claude Desktop manually and re-run if the problem persists.",
        );
      }
      return;
    }
    case "win32": {
      const exe = appCandidates().find((p) => existsSync(p));
      if (!exe) {
        throw new OpperError(
          "AGENT_NOT_FOUND",
          "Claude Desktop executable was not found.",
          "Open Claude Desktop manually once and re-run.",
        );
      }
      const result = run("powershell.exe", [
        "-NoProfile",
        "-Command",
        `Start-Process -FilePath '${exe.replace(/'/g, "''")}'`,
      ], {timeout: 5_000});
      if (result.code !== 0) {
        throw new OpperError(
          "AGENT_NOT_FOUND",
          "Failed to start Claude Desktop.",
          (result.stderr.trim() || "Start-Process exited non-zero.") +
            " Open Claude Desktop manually and re-run if the problem persists.",
        );
      }
      return;
    }
  }
}

async function spawn(args: string[], routing: OpperRouting): Promise<number> {
  if (args.length > 0) {
    throw new OpperError(
      "AGENT_CONFIG_CONFLICT",
      "claude-desktop does not accept passthrough arguments.",
    );
  }
  if (!isClaudeDesktopModelId(routing.model)) {
    throw new OpperError(
      "INVALID_ARGUMENT",
      `Claude Desktop does not support model "${routing.model}"`,
      `Choose one of: ${CLAUDE_DESKTOP_MODEL_IDS.join(", ")}.`,
    );
  }
  await applyOpperProfile(routing.apiKey, routing.model, routing.desktopProxy, {apiBaseUrl: routing.apiBaseUrl ?? OPPER_HOST, projectUuid: routing.projectUuid, modelKinds: routing.modelKinds, explicitModel: routing.modelOverride ?? (routing.apiBaseUrl ? undefined : routing.model)});

  if (isClaudeRunning()) {
    if (platform() === "win32") {
      throw new OpperError("AGENT_CONFIG_CONFLICT", "Opper is configured, but Claude Desktop is already running.", "Quit Claude Desktop and re-run the same opper launch command, or reopen it from the Start menu. Existing work stays available until you quit.");
    }
    quitClaude();
    const exited = await waitForClaudeExit();
    if (!exited) {
      throw new OpperError(
        "AGENT_RESTORE_FAILED",
        "Claude Desktop did not quit within 5s.",
        "Quit Claude Desktop manually and re-run `opper launch claude-desktop`.",
      );
    }
  }
  openClaude();
  return 0;
}

export const claudeDesktop: AgentAdapter = {
  name: "claude-desktop",
  launchesInBackground: true,
  displayName: "Claude Desktop",
  docsUrl: "https://claude.ai/download",
  supportsModel: isClaudeDesktopModelId,
  modelSupportHint:
    "Use a claude-* pool or provider/claude-* route (not dynamic/*).",
  detect,
  isConfigured,
  configure,
  unconfigure,
  install,
  spawn,
};
