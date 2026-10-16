import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, rm, mkdtemp, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { applyEdits, modify, parseTree, findNodeAtLocation, createScanner } from "jsonc-parser";
import { deleteJsoncProperty, parseJsoncObject } from "../util/jsonc.js";
import { which } from "../util/which.js";
import { run } from "../util/run.js";
import { OpperError } from "../errors.js";
import { npmInstallGlobal } from "./npm-install.js";
import { OPPER_COMPAT_URL, OPPER_HOST } from "../config/endpoints.js";
import { DEFAULT_MODELS } from "../config/models.js";
import { fetchPiModels, type PiModel } from "../setup/pi-models.js";
import { assetPath } from "../util/assets.js";
import type {
  AgentAdapter,
  ConfigureOptions,
  DetectResult,
  OpperRouting,
} from "./types.js";

// The provider key we own inside ~/.pi/agent/models.json. Everything else in
// the user's pi home — skills, settings, MCP servers, other providers — is
// theirs and is loaded normally. Launch uses an explicit temporary extension.
const PROVIDER_KEY = "opper";

function apiKeyEnvReference(version?: string): string {
  // The legacy @mariozechner release resolves a bare name via process.env.
  // Current Pi requires explicit interpolation and treats bare names literally.
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)/);
  const legacy = match && Number(match[1]) === 0 && Number(match[2]) <= 76;
  return legacy ? "OPPER_API_KEY" : "${OPPER_API_KEY}";
}

function legacyMaxLevel(version?: string): boolean {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)/);
  return Boolean(match && Number(match[1]) === 0 &&
    (Number(match[2]) < 80 || (Number(match[2]) === 80 && Number(match[3]) < 6)));
}

function piAgentDir(): string {
  let configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return join(homedir(), ".pi", "agent");
  // Match Pi's path normalization for its configuration-directory override.
  if (process.platform === "win32" && configured.startsWith("/") &&
      !configured.startsWith("//") && !configured.includes("\\")) {
    const drive = configured.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (drive) configured = `${drive[1]!.toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (configured === "~") return homedir();
  if (configured.startsWith("~/") || (process.platform === "win32" && configured.startsWith("~\\"))) {
    return join(homedir(), configured.slice(2));
  }
  if (configured.startsWith("file://")) return fileURLToPath(configured);
  return configured;
}
function piConfigPath(): string {
  return join(piAgentDir(), "models.json");
}
interface PiModelsFile {
  providers?: Record<string, unknown>;
  [k: string]: unknown;
}

async function readConfig(options: { configure?: boolean; routing?: OpperRouting; allowedIds?: Set<string> } = {}): Promise<{ text: string; value: PiModelsFile }> {
  const cfg = piConfigPath();
  const text = existsSync(cfg) ? await readFile(cfg, "utf8") : "{}\n";
  try {
    const value = parseJsoncObject(text) as PiModelsFile;
    if (value.providers !== undefined) {
      if (value.providers === null || typeof value.providers !== "object" || Array.isArray(value.providers)) {
        throw new SyntaxError("Expected providers to be an object");
      }
      for (const provider of Object.values(value.providers)) {
        if (provider === null || typeof provider !== "object" || Array.isArray(provider)) {
          throw new SyntaxError("Expected provider entries to be objects");
        }
      }
    }
    const opper = value.providers?.[PROVIDER_KEY] as Record<string, unknown> | undefined;
    const object = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item);
    const headers = (item: unknown, location: string, relevant = true): void => {
      if (item === undefined) return;
      if (!object(item) || Object.values(item).some(v => typeof v !== "string")) {
        throw new SyntaxError(`Expected string-valued headers at ${location}`);
      }
      if (!relevant || (!options.configure && !options.routing)) return;
      for (const [name, header] of Object.entries(item)) {
        const lower = name.toLowerCase();
        if (["authorization", "proxy-authorization", "x-api-key", "api-key", "x-goog-api-key"].includes(lower)) {
          throw new OpperError("AGENT_CONFIG_CONFLICT", `Opper configuration has a conflicting ${name} header at ${location}. Existing configuration was preserved.`,
            `Remove the ${name} header from ${location} in ${cfg}; Opper supplies authentication through OPPER_API_KEY.`);
        }
        if (options.routing && ((lower === "x-opper-project" && header !== options.routing.projectUuid) ||
            lower === "x-opper-trace-id" || lower === "x-opper-parent-span-id")) {
          throw new OpperError("AGENT_CONFIG_CONFLICT", `Opper configuration has a conflicting ${name} header at ${location}. Existing configuration was preserved.`,
            `Remove the ${name} header from ${location} in ${cfg} before launching; the launcher supplies the selected project and per-session trace headers.`);
        }
      }
    };
    if (opper) {
      headers(opper.headers, "providers.opper.headers");
      if (opper.models !== undefined) {
        if (!Array.isArray(opper.models)) throw new SyntaxError("Expected models to be an array");
        const ids = new Set<string>();
        for (const model of opper.models) {
          if (!object(model) || typeof model.id !== "string" || !model.id || ids.has(model.id)) {
            throw new SyntaxError("Expected model entries with unique string IDs");
          }
          ids.add(model.id);
          headers(model.headers, `providers.opper.models[${model.id}].headers`, !options.allowedIds || options.allowedIds.has(model.id));
        }
      }
      if (opper.modelOverrides !== undefined) {
        if (!object(opper.modelOverrides)) throw new SyntaxError("Expected modelOverrides to be an object");
        for (const [id, override] of Object.entries(opper.modelOverrides)) {
          if (!object(override)) throw new SyntaxError("Expected modelOverrides entries to be objects");
          headers(override.headers, `providers.opper.modelOverrides[${id}].headers`, !options.allowedIds || options.allowedIds.has(id));
        }
      }
    }
    return { text, value };
  } catch (err) {
    if (err instanceof OpperError) throw err;
    throw new OpperError(
      "AGENT_CONFIG_CONFLICT",
      `Cannot safely use ${cfg}: expected a valid JSON or JSONC object with object-valued providers, models, and headers. Existing configuration was preserved.`,
      "Correct the invalid configuration structure before retrying.",
    );
  }
}

async function writeConfig(text: string): Promise<void> {
  const cfg = piConfigPath();
  await mkdir(dirname(cfg), { recursive: true });
  await writeFile(cfg, text, { mode: 0o600 });
}

/**
 * Idempotently install our `opper` provider entry. Other providers in the same
 * file (ollama, etc.) are preserved. Per-session trace headers are added by the
 * shipped session extension, not baked in here.
 */
async function setOpperProvider(
  apiKey: string,
  launchModel: string,
  baseUrl: string,
  projectUuid?: string,
  catalog: PiModel[] = [],
): Promise<void> {
  const cfg = await readConfig({ configure: true, allowedIds: new Set(catalog.map(model => model.id)) });
  const prior = (cfg.value.providers?.[PROVIDER_KEY] ?? {}) as Record<string, unknown>;
  let text = cfg.text;
  const path = ["providers", PROVIDER_KEY];
  const edit = (keyPath: (string | number)[], value: unknown): void => {
    text = value === undefined ? deleteJsoncProperty(text, keyPath) : applyEdits(text, modify(text, keyPath, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }));
  };
  const managedHeaders = new Set(["x-opper-project", "x-opper-trace-id", "x-opper-parent-span-id"]);
  const refreshHeaders = (headerPath: (string | number)[], existing: unknown, provider = false): void => {
    for (const name of Object.keys((existing ?? {}) as Record<string, unknown>)) {
      if (managedHeaders.has(name.toLowerCase()) && !(provider && projectUuid && name === "X-Opper-Project")) {
        edit([...headerPath, name], undefined);
      }
    }
    if (provider && projectUuid) edit([...headerPath, "X-Opper-Project"], projectUuid);
  };
  for (const [key, value] of Object.entries({ api: "openai-completions", apiKey, authHeader: true, baseUrl })) {
    edit([...path, key], value);
  }
  refreshHeaders([...path, "headers"], prior.headers, true);

  const allowed = new Map(catalog.map(model => [model.id, model]));
  const existing = (prior.models ?? []) as Record<string, unknown>[];
  const removed = existing.filter(model => !allowed.has(model.id as string)).map(model => model.id as string);
  if (prior.models === undefined) edit([...path, "models"], []);
  // Delete only each withdrawn array node and its separator, preserving comments
  // around retained models. Retained entries keep their existing order.
  for (let index = existing.length - 1; index >= 0; index--) {
    if (allowed.has(existing[index]!.id as string)) continue;
    const node = findNodeAtLocation(parseTree(text)!, [...path, "models", index])!;
    const siblings = node.parent!.children!;
    const previous = siblings[index - 1];
    const edits = [{ offset: node.offset, length: node.length, content: "" }];
    const scanner = createScanner(text, true);
    scanner.setPosition(previous ? previous.offset + previous.length : node.offset + node.length);
    scanner.scan();
    if (text.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength()) === ",") {
      edits.push({ offset: scanner.getTokenOffset(), length: scanner.getTokenLength(), content: "" });
    }
    text = applyEdits(text, edits);
  }
  const retained = existing.filter(model => allowed.has(model.id as string));
  const ordered = [...retained.map(model => allowed.get(model.id as string)!),
    ...catalog.filter(model => !retained.some(priorModel => priorModel.id === model.id))];
  for (const [index, model] of ordered.entries()) {
    const modelPath = [...path, "models", index];
    const original = retained[index];
    if (!original) edit(modelPath, { ...model, ...(model.id === launchModel ? { _launch: true } : {}) });
    else {
      for (const [key, value] of Object.entries(model)) {
        if (key === "compat") {
          for (const [compatKey, compatValue] of Object.entries(value as Record<string, unknown>)) edit([...modelPath, key, compatKey], compatValue);
        } else edit([...modelPath, key], value);
      }
      // Per-model routing must not override the selected managed provider.
      for (const key of ["api", "baseUrl", "apiKey", "authHeader"]) edit([...modelPath, key], undefined);
      edit([...modelPath, "_launch"], model.id === launchModel ? true : undefined);
      refreshHeaders([...modelPath, "headers"], original.headers);
    }
  }
  for (const [id, override] of Object.entries((prior.modelOverrides ?? {}) as Record<string, Record<string, unknown>>)) {
    if (!allowed.has(id)) continue; // Unknown overrides cannot add models; preserve future preferences.
    refreshHeaders([...path, "modelOverrides", id, "headers"], override.headers);
  }
  if (text !== cfg.text) await writeConfig(text);
  if (removed.length) process.stdout.write(`Removed Opper model IDs absent from the current allowed catalog: ${removed.join(", ")}.\n`);
}

async function detect(): Promise<DetectResult> {
  const path = await which("pi");
  if (!path) return { installed: false };

  const versionResult = run("pi", ["--version"]);
  const versionMatch = versionResult.code === 0
    ? `${versionResult.stdout}\n${versionResult.stderr ?? ""}`.match(/v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/)
    : null;
  const parsed = versionMatch ? versionMatch[1] : undefined;

  return {
    installed: true,
    ...(parsed ? { version: parsed } : {}),
    configPath: piConfigPath(),
  };
}

async function install(): Promise<void> {
  await npmInstallGlobal("@earendil-works/pi-coding-agent", "https://pi.dev", {
    engineStrict: true,
    failureHint: "If npm reports EBADENGINE, upgrade the Node.js used by npm to Node.js 22.19.0 or later, then retry.",
  });
}

async function isConfigured(): Promise<boolean> {
  const cfg = await readConfig();
  return Boolean(cfg.value.providers?.[PROVIDER_KEY]);
}

async function configure(opts: ConfigureOptions): Promise<void> {
  if (!opts.apiKey) {
    throw new OpperError(
      "AUTH_REQUIRED",
      "Pi configuration needs an Opper API key.",
      "Run `opper login` first, or set OPPER_API_KEY.",
    );
  }
  const version = (await detect()).version;
  const catalog = await fetchPiModels({apiKey: opts.apiKey, baseUrl: opts.baseUrl ?? OPPER_HOST, projectUuid: opts.projectUuid}, {legacyMaxLevel:legacyMaxLevel(version)});
  await setOpperProvider(apiKeyEnvReference(version), DEFAULT_MODELS.opus, opts.baseUrl ? `${opts.baseUrl}/v3/compat` : OPPER_COMPAT_URL, opts.projectUuid, catalog);
  process.stdout.write("Plain `pi` requires OPPER_API_KEY in its environment; `opper launch pi` supplies your selected Opper key automatically.\n");
}

async function unconfigure(): Promise<void> {
  const cfg = await readConfig();
  if (cfg.value.providers?.[PROVIDER_KEY] !== undefined) {
    await writeConfig(deleteJsoncProperty(cfg.text, ["providers", PROVIDER_KEY]));
  }
}

async function spawn(args: string[], routing: OpperRouting): Promise<number> {
  const version = (await detect()).version;
  const catalog = await fetchPiModels({apiKey: routing.apiKey, baseUrl: routing.apiBaseUrl, projectUuid: routing.projectUuid}, {legacyMaxLevel:legacyMaxLevel(version)});
  const model = catalog.some(m => m.id === routing.model) ? routing.model : catalog[0]!.id;
  if (routing.modelOverride && !catalog.some(m => m.id === routing.modelOverride)) {
    throw new OpperError("API_ERROR", "The selected model is not in this credential's allowed Pi catalog.");
  }
  // Pi can load this provider directly from an explicit extension. Keep all
  // launch-only files in a private temporary directory so user configuration,
  // custom providers, and discovered extensions are never rewritten.
  // Pi merges saved headers into extension providers; reject overrides that
  // could replace this launch's credential, selected project, or session trace.
  await readConfig({ routing, allowedIds: new Set(catalog.map(model => model.id)) });
  const launchDir = await mkdtemp(join(tmpdir(), "opper-pi-"));
  try {
    const extension = join(launchDir, "opper-session.ts");
    const catalogPath = join(launchDir, "catalog.json");
    await copyFile(assetPath(join("pi-opper-extension", "opper-session.ts")), extension);
    await writeFile(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
    const userPicked = args.some(
      (a) => a === "--model" || a === "-m" || a.startsWith("--model="),
    );
    // Pi needs both provider and model to resolve a non-default provider.
    const piArgs = ["--provider", PROVIDER_KEY,
      ...(userPicked ? [] : ["--model", model]), "--extension", extension, ...args];
    return run("pi", piArgs, {
      inherit: true,
      env: {
        ...process.env,
        OPPER_API_KEY: routing.apiKey,
        OPPER_BASE_URL: routing.baseUrl,
        OPPER_PROJECT_UUID: routing.projectUuid ?? "",
        OPPER_PI_CATALOG_PATH: catalogPath,
      },
    }).code;
  } finally {
    await rm(launchDir, { recursive: true, force: true });
  }
}

export const pi: AgentAdapter = {
  name: "pi",
  displayName: "Pi",
  docsUrl: "https://pi.dev",
  detect,
  isConfigured,
  configure,
  unconfigure,
  install,
  spawn,
};
