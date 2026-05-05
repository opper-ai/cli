import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { OpperError } from "../errors.js";
import { OPPER_COMPAT_URL } from "../config/endpoints.js";
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

function windowsAppCandidates(): string[] {
  const local = windowsLocalAppData();
  if (!local) return [];
  return [
    join(local, "Programs", "Claude", "Claude.exe"),
    join(local, "Programs", "Claude Desktop", "Claude.exe"),
    join(local, "Claude", "Claude.exe"),
    join(local, "Claude Nest", "Claude.exe"),
    join(local, "Claude Desktop", "Claude.exe"),
    join(local, "AnthropicClaude", "Claude.exe"),
  ];
}

function appCandidates(): string[] {
  switch (platform()) {
    case "darwin":
      return darwinAppCandidates();
    case "win32":
      return windowsAppCandidates();
    default:
      return [];
  }
}

const OPPER_PROFILE_ID = "727f05c8-a429-43cc-b1c6-36d8883d98b8";
const OPPER_PROFILE_NAME = "Opper";

interface ThirdPartyPaths {
  desktopConfig: string;
  meta: string;
  profile: string;
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
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function writeJson(path: string, data: JsonObject): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
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

async function profileIsOpperGateway(target: ThirdPartyPaths): Promise<boolean> {
  const meta = await readJsonOrNull(target.meta);
  if (meta?.appliedId !== OPPER_PROFILE_ID) return false;
  const profile = await readJsonOrNull(target.profile);
  if (!profile) return false;
  if (profile.inferenceProvider !== "gateway") return false;
  const url = typeof profile.inferenceGatewayBaseUrl === "string"
    ? profile.inferenceGatewayBaseUrl.replace(/\/+$/, "")
    : "";
  if (url !== OPPER_COMPAT_URL.replace(/\/+$/, "")) return false;
  const key = typeof profile.inferenceGatewayApiKey === "string"
    ? profile.inferenceGatewayApiKey.trim()
    : "";
  return key.length > 0;
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

async function writeGatewayProfile(path: string, apiKey: string): Promise<void> {
  const cfg = await readJsonAllowMissing(path);
  cfg.inferenceProvider = "gateway";
  cfg.inferenceGatewayBaseUrl = OPPER_COMPAT_URL;
  cfg.inferenceGatewayApiKey = apiKey;
  cfg.inferenceGatewayAuthScheme = "bearer";
  cfg.disableDeploymentModeChooser = true;
  delete cfg.inferenceModels;
  await writeJson(path, cfg);
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

async function configure(opts: ConfigureOptions): Promise<void> {
  if (!opts.apiKey) {
    throw new OpperError(
      "AUTH_REQUIRED",
      "Claude Desktop configuration needs an Opper API key.",
      "Run `opper login` first, or set OPPER_API_KEY.",
    );
  }
  const targets = targetPaths();
  for (const path of targets.normalConfigs) {
    await writeDeploymentMode(path, "3p");
  }
  for (const target of targets.thirdPartyProfiles) {
    await writeDeploymentMode(target.desktopConfig, "3p");
    await writeMetaWithOpperEntry(target.meta);
    await writeGatewayProfile(target.profile, opts.apiKey);
  }
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

async function blankGatewayProfile(path: string): Promise<void> {
  const cfg = await readJsonOrNull(path);
  if (!cfg) return;
  delete cfg.inferenceProvider;
  delete cfg.inferenceGatewayBaseUrl;
  delete cfg.inferenceGatewayApiKey;
  delete cfg.inferenceGatewayAuthScheme;
  delete cfg.inferenceModels;
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
  for (const path of targets.normalConfigs) {
    await maybeFlipToFirstParty(path);
  }
  for (const target of targets.thirdPartyProfiles) {
    await maybeFlipToFirstParty(target.desktopConfig);
    await clearOpperEntryFromMeta(target.meta);
    await blankGatewayProfile(target.profile);
  }
}

async function install(): Promise<void> {
  throw new OpperError(
    "AGENT_NOT_FOUND",
    "Claude Desktop must be installed manually.",
    "Download Claude Desktop from https://claude.ai/download.",
  );
}

async function spawn(args: string[], routing: OpperRouting): Promise<number> {
  if (args.length > 0) {
    throw new OpperError(
      "AGENT_NOT_FOUND",
      "claude-desktop does not accept passthrough arguments.",
    );
  }
  await configure({ apiKey: routing.apiKey });
  // Quit + reopen logic added in Task 8.
  return 0;
}

export const claudeDesktop: AgentAdapter = {
  name: "claude-desktop",
  displayName: "Claude Desktop",
  docsUrl: "https://claude.ai/download",
  detect,
  isConfigured,
  configure,
  unconfigure,
  install,
  spawn,
};
