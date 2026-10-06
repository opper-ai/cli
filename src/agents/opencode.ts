import { spawnSync } from "../util/spawn.js";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { deleteJsoncProperty, parseJsoncObject } from "../util/jsonc.js";
import { which } from "../util/which.js";
import { npmInstallGlobal } from "./npm-install.js";
import { openCodeLoginBridgePath } from "../setup/opencode-login-bridge.js";
import { configureOpenCode } from "../setup/opencode.js";
import { OPPER_COMPAT_URL, OPPER_HOST } from "../config/endpoints.js";
import { resolveOpenCodeModels, preserveOpenCodeVariants, compatibleOpenCodeSettings, type OpenCodeModel } from "../setup/opencode-models.js";
import { opencodeConfigPath } from "../util/editor-paths.js";
import { withJsonKeys } from "../util/config-snapshot.js";
import { OpperError } from "../errors.js";
import type {
  AgentAdapter,
  DetectResult,
  OpperRouting,
  SpawnOptions,
  ConfigureOptions,
} from "./types.js";

async function detect(): Promise<DetectResult> {
  const binaryPath = await which("opencode");
  if (!binaryPath) return { installed: false };
  const cfg = opencodeConfigPath("global");
  return {
    installed: true,
    ...(existsSync(cfg) ? { configPath: cfg } : {}),
  };
}

async function install(): Promise<void> {
  await npmInstallGlobal("opencode-ai", "https://opencode.ai");
}

async function isConfigured(): Promise<boolean> {
  const cfg = opencodeConfigPath("global");
  if (!existsSync(cfg)) return false;
  try {
    const parsed = parseJsoncObject(readFileSync(cfg, "utf8")) as {
      provider?: { opper?: unknown };
    };
    return parsed.provider?.opper !== undefined;
  } catch {
    return false;
  }
}

async function configure(opts: ConfigureOptions = {}): Promise<void> {
  // Prefer the live catalogue over the bundled list. `/v3/compat/models` is
  // scoped to the key, so this is also the only way the user's own pools and
  // `dynamic/<name>` routes reach OpenCode's picker. Only setup without a key
  // uses the template; authenticated catalog failures leave config untouched.
  const models = opts.apiKey ? await resolveOpenCodeModels({ apiKey: opts.apiKey, baseUrl: opts.baseUrl ?? OPPER_HOST, ...(opts.projectUuid ? { projectUuid: opts.projectUuid } : {}) }) : await resolveOpenCodeModels();

  // overwrite: true so a re-run pulls in the latest models, costs and
  // defaults. Without it, an existing `provider.opper` block from an older
  // CLI version would be left in place and the new models would never
  // appear in OpenCode's picker.
  await configureOpenCode({ location: "global", overwrite: true, ...(models ? { models } : {}), ...(opts.projectUuid ? { projectUuid: opts.projectUuid } : {}), ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) });
}

async function unconfigure(): Promise<void> {
  const cfg = opencodeConfigPath("global");
  if (!existsSync(cfg)) return;
  let parsed: { provider?: Record<string, unknown>; [k: string]: unknown };
  try {
    parsed = parseJsoncObject(readFileSync(cfg, "utf8")) as typeof parsed;
  } catch {
    return;
  }
  if (!parsed.provider || parsed.provider.opper === undefined) return;

  const original = readFileSync(cfg, "utf8");
  const keyPath = Object.keys(parsed.provider).length === 1 ? ["provider"] : ["provider", "opper"];
  await writeFile(cfg, deleteJsoncProperty(original, keyPath), "utf8");
}

/**
 * Rewrite `provider.opper.options.baseURL` in the existing opencode.json to
 * the per-launch URL (typically a /v3/session/<sid>/<tags...> URL). The
 * template only writes once via `configureOpenCode`, so without this step
 * launching a session would fall back to the default compat URL baked into
 * the template.
 */
async function setSessionBaseUrl(
  baseUrl: string,
  location: "global" | "local",
): Promise<void> {
  const cfg = opencodeConfigPath(location);
  if (!existsSync(cfg)) return;
  let parsed: {
    provider?: Record<string, { options?: Record<string, unknown> }>;
    [k: string]: unknown;
  };
  try {
    parsed = parseJsoncObject(readFileSync(cfg, "utf8")) as typeof parsed;
  } catch {
    return;
  }
  const opper = parsed.provider?.opper;
  if (!opper) return;
  const original = readFileSync(cfg, "utf8");
  const updated = applyEdits(original, modify(original, ["provider", "opper", "options", "baseURL"], baseUrl, {}));
  await writeFile(cfg, updated, "utf8");
}

/**
 * Read `provider.opper.options.baseURL` from an opencode config without
 * mutating the file. Returns undefined when the file or the provider is
 * absent, or when the JSON is malformed — callers fall back to a default.
 */
function readBaseUrl(location: "global" | "local"): string | undefined {
  const cfg = opencodeConfigPath(location);
  if (!existsSync(cfg)) return undefined;
  try {
    const parsed = parseJsoncObject(readFileSync(cfg, "utf8")) as {
      provider?: { opper?: { options?: { baseURL?: unknown } } };
    };
    const url = parsed.provider?.opper?.options?.baseURL;
    return typeof url === "string" ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The baseURL to put back after a launch.
 *
 * A hand-edited self-hosted gateway must survive, which is why the pre-launch
 * value is restored at all. But an OPPER url that is not the current compat
 * endpoint is not a preference, it is rot: anyone who followed the old docs
 * has `/v2/openai` pinned, and restoring it verbatim every launch means they
 * are never upgraded. A leftover `/v3/session/<id>` from a killed run is the
 * same problem. Both point at our own host, so both are safe to replace;
 * anything on another host is the user's own and is left alone.
 */
export function restoreTarget(stored: string | undefined): string {
  if (!stored) return OPPER_COMPAT_URL;
  if (stored === OPPER_COMPAT_URL) return stored;
  return stored.startsWith(OPPER_HOST) ? OPPER_COMPAT_URL : stored;
}

/** Apply launch settings after OpenCode's project and custom file layers. */
function runtimeConfig(models: Record<string, OpenCodeModel>, routing: OpperRouting): string {
  function object(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new OpperError("AGENT_CONFIG_CONFLICT", "Invalid OPENCODE_CONFIG_CONTENT: expected configuration objects.");
    }
    return value as Record<string, unknown>;
  }
  const errors: ParseError[] = [];
  const raw = process.env.OPENCODE_CONFIG_CONTENT;
  const parsed: unknown = raw ? parse(raw, errors, { allowTrailingComma: true }) : {};
  if (errors.length) {
    throw new OpperError("AGENT_CONFIG_CONFLICT", "Cannot parse OPENCODE_CONFIG_CONTENT. Existing configuration was preserved.");
  }
  const config = object(parsed);
  const providers = config.provider === undefined ? {} : object(config.provider);
  const opper = providers.opper === undefined ? {} : object(providers.opper);
  const options = opper.options === undefined ? {} : object(opper.options);
  const headers = options.headers === undefined ? undefined : Object.fromEntries(
    Object.entries(object(options.headers)).filter(([name]) => !["authorization", "x-opper-project"].includes(name.toLowerCase())),
  );
  // Refresh only models already present inline. Catalog metadata remains in
  // the generated file, keeping this override below OS environment limits.
  const inlineModels = opper.models === undefined ? undefined : object(opper.models);
  const refreshed = inlineModels ? preserveOpenCodeVariants(models, inlineModels) : {};
  const inline = inlineModels ? Object.fromEntries(Object.keys(inlineModels).filter((id) => id in models).map((id) => {
    const policy = object(refreshed[id]);
    return [id, { ...compatibleOpenCodeSettings(object(inlineModels[id])), variants: policy.variants, options: policy.options ?? {} }];
  })) : undefined;
  return JSON.stringify({
    ...config,
    ...(routing.modelOverride ? {
      model: routing.modelOverride.startsWith("opper/")
        ? routing.modelOverride
        : `opper/${routing.modelOverride}`,
    } : {}),
    provider: {
      ...providers,
      opper: {
        ...opper,
        npm: "@ai-sdk/openai-compatible",
        ...(inline ? { models: inline } : {}),
        options: { ...options, headers: { ...headers, ...(routing.projectUuid ? { "X-Opper-Project": routing.projectUuid } : {}) }, baseURL: routing.baseUrl, apiKey: "{env:OPPER_API_KEY}" },
        // Keep the full model metadata in the generated config file. A live
        // catalog can exceed Linux's per-environment-variable size limit.
        whitelist: Object.keys(models),
      },
    },
  });
}

/**
 * OpenCode 2 runs agents on a shared background server whose environment was
 * fixed when it started, so OPENCODE_CONFIG_CONTENT and {env:OPPER_API_KEY}
 * from this launch would be ignored. Its private (`--standalone`) server is
 * spawned with our environment instead. 1.x has no server split.
 */
export function openCodeMajorVersion(env: NodeJS.ProcessEnv): number | undefined {
  const result = spawnSync("opencode", ["--version"], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 30_000,
  });
  // 1.x prints "1.18.29"; 2.x prints "opencode v2.0.20".
  const match = result.status === 0 ? /(\d+)\.\d+\.\d+/.exec(result.stdout ?? "") : null;
  return match ? Number(match[1]) : undefined;
}

const V2_SUBCOMMANDS = new Set([
  "upgrade", "update", "uninstall", "acp", "api", "debug", "auth", "mcp", "plugin",
  "models", "stats", "mini", "run", "session", "service", "reload", "pair", "serve",
]);
// Subcommands that talk to a model-serving server and accept `--standalone`
// after the subcommand name. The flag is rejected before a subcommand.
const V2_STANDALONE_SUBCOMMANDS = new Set(["api", "mini", "models", "run", "stats"]);

/** Route an OpenCode 2 invocation to a private server that sees this launch's env. */
export function withStandaloneServer(args: string[]): string[] {
  if (args.some((arg) => arg === "--standalone" || arg === "--server" || arg.startsWith("--server="))) return args;
  const [command] = args;
  if (command === undefined || command.startsWith("-") || !V2_SUBCOMMANDS.has(command)) {
    return ["--standalone", ...args];
  }
  return V2_STANDALONE_SUBCOMMANDS.has(command) ? [command, "--standalone", ...args.slice(1)] : args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** OpenCode's own merge: nested objects combine, anything else is replaced. */
function mergeDeep(base: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;
    const previous = merged[key];
    merged[key] = isRecord(previous) && isRecord(value) ? mergeDeep(previous, value) : value;
  }
  return merged;
}

/**
 * Effective configuration from inspection output. OpenCode 1.x prints one
 * merged object; 2.x lists sources from lowest to highest priority, where
 * each loaded document carries its (already migrated) settings in `info`.
 */
export function effectiveOpenCodeConfig(text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !Array.isArray(value)) return parseJsoncObject(text);
  return value.reduce<Record<string, unknown>>((config, source) => {
    if (!isRecord(source)) throw new SyntaxError("Expected configuration sources");
    if (source.info === undefined) return config;
    if (!isRecord(source.info)) throw new SyntaxError("Expected a configuration object");
    return mergeDeep(config, source.info);
  }, {});
}

/**
 * Inspect merged settings before changing Opper's provider configuration.
 * OpenCode may add its own $schema metadata while loading a JSON file.
 */
function checkEffectiveAuthorization(models: Record<string, OpenCodeModel>, env: NodeJS.ProcessEnv, projectUuid?: string, majorVersion?: number): Record<string, unknown> {
  let config: Record<string, unknown>;
  let directory: string | undefined;
  let output: number | undefined;
  try {
    // OpenCode can exit before buffered pipe output has drained. A regular
    // file captures large catalogs completely; debug output may contain keys.
    directory = mkdtempSync(join(tmpdir(), "opper-opencode-inspect-"));
    const path = join(directory, "config.json");
    output = openSync(path, "wx", 0o600);
    // 2.x `debug config` asks the shared background server, which never sees
    // this launch's OPENCODE_CONFIG_CONTENT. Ask a private one instead.
    const inspect = majorVersion !== undefined && majorVersion >= 2
      ? ["api", "--standalone", "config.get", "--param", `directory=${process.cwd()}`]
      : ["debug", "config"];
    const result = spawnSync("opencode", inspect, {
      env,
      encoding: "utf8",
      stdio: ["ignore", output, "ignore"],
      timeout: 30_000,
    });
    if (result.error || result.status !== 0) {
      throw new Error("Configuration inspection failed");
    }
    config = effectiveOpenCodeConfig(readFileSync(path, "utf8"));
  } catch {
    // Debug output can contain credentials. Never include it (or subprocess
    // errors) in the user-facing failure.
    throw new OpperError(
      "AGENT_CONFIG_CONFLICT",
      "Could not inspect OpenCode's effective configuration before launch.",
      "Run `opencode debug config` locally to diagnose the configuration, then retry.",
    );
  } finally {
    try {
      if (output !== undefined) closeSync(output);
    } finally {
      if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    }
  }
  const record = (value: unknown): Record<string, unknown> | undefined =>
    isRecord(value) ? value : undefined;
  // 1.x keeps request headers in `options.headers` (plus model `headers`).
  // 2.x migrates that to `headers`, and also sends `settings.headers`.
  const headerSets = (entry: Record<string, unknown> | undefined): unknown[] =>
    [entry?.headers, record(entry?.options)?.headers, record(entry?.settings)?.headers];
  const providers = [record(config.provider)?.opper, record(config.providers)?.opper].map(record);
  const providerHeaders = providers.flatMap(headerSets);
  const modelSettings = providers.flatMap((opper) =>
    Object.keys(models).flatMap((id) => {
      const entry = record(record(opper?.models)?.[id]);
      return [entry, ...Object.values(record(entry?.variants) ?? {}).map(record)
        .filter((variant) => variant?.disabled !== true)];
    }));
  const modelHeaders = modelSettings.flatMap(headerSets);
  const hasAuthorization = (headers: unknown): boolean =>
    Object.keys(record(headers) ?? {}).some((name) => name.toLowerCase() === "authorization");
  if (providerHeaders.some(hasAuthorization) || modelHeaders.some(hasAuthorization)) {
    throw new OpperError(
      "AGENT_CONFIG_CONFLICT",
      "OpenCode's effective Opper configuration contains an Authorization header that can override the selected API key.",
      "Remove Authorization headers from Opper provider and model settings, then retry with the desired --key slot.",
    );
  }
  const conflictingProject = (headers: unknown, providerLevel = false): boolean =>
    Object.entries(record(headers) ?? {}).some(([name, value]) => {
      if (name.toLowerCase() !== "x-opper-project") return false;
      // OpenCode 1.x can mask header values in `debug config`. Only our final
      // inline provider header has a known value; masked model overrides or
      // differently cased duplicate headers cannot be verified safely.
      if (providerLevel && projectUuid && name === "X-Opper-Project" && value === "***") return false;
      return value !== projectUuid;
    });
  if (providerHeaders.some((headers) => conflictingProject(headers, true)) || modelHeaders.some((headers) => conflictingProject(headers))) {
    throw new OpperError("AGENT_CONFIG_CONFLICT", "OpenCode's effective Opper configuration contains a project header that overrides the selected target.", "Remove X-Opper-Project headers from Opper provider and model settings, then choose a target with --project-uuid.");
  }
  if (modelSettings.some((entry) => [entry, record(entry?.options), record(entry?.settings)].some((setting) =>
    Object.keys(setting ?? {}).some((name) => ["apikey", "baseurl"].includes(name.toLowerCase()))))) {
    throw new OpperError("AGENT_CONFIG_CONFLICT", "OpenCode's effective Opper model settings contain credential or endpoint overrides.",
      "Remove apiKey and baseURL from Opper model and variant settings, then retry with the selected key and route.");
  }
  return config;
}

function checkEffectiveEfforts(models: Record<string, OpenCodeModel>, config: Record<string, unknown>): void {
  const providers = [config.provider, config.providers].flatMap((group) =>
    isRecord(group) && isRecord(group.opper) ? [group.opper] : []);
  const optionSets = (value: unknown): Record<string, unknown>[] => isRecord(value)
    ? [value, ...(isRecord(value.options) ? [value.options] : []), ...(isRecord(value.settings) ? [value.settings] : [])] : [];
  for (const provider of providers) {
    const inherited = isRecord(provider.models) ? provider.models : {};
    for (const [id, model] of Object.entries(models)) {
      if (!model.variants || !isRecord(inherited[id])) continue;
      const supported = new Set(Object.values(model.variants).flatMap((variant) =>
        !variant.disabled && typeof variant.reasoningEffort === "string" ? [variant.reasoningEffort] : []));
      const entry = inherited[id];
      const settings = [...optionSets(entry), ...Object.values(isRecord(entry.variants) ? entry.variants : {})
        .filter((variant) => !isRecord(variant) || variant.disabled !== true).flatMap(optionSets)];
      if (settings.some((setting) =>
        (setting.reasoningEffort !== undefined && !supported.has(String(setting.reasoningEffort))) ||
          setting.thinking !== undefined)) {
        throw new OpperError("AGENT_CONFIG_CONFLICT", "OpenCode's inherited model settings contain an unsupported reasoning effort.",
          "Refresh the project's Opper configuration or remove unsupported effort settings, then retry.");
      }
    }
  }
}

async function spawn(
  args: string[],
  routing: OpperRouting,
  opts: SpawnOptions = {},
): Promise<number> {
  const scope = opts.configScope ?? "user";
  // spawn() rewrites the config on EVERY launch (both scopes below), so
  // resolving the catalogue here is what makes `opper launch opencode`
  // pick up new models, changed policy, and newly deployed routes without
  // the user doing anything. Resolved once and shared by both branches.
  const models = await resolveOpenCodeModels({
    apiKey: routing.apiKey,
    baseUrl: routing.apiBaseUrl,
    ...(routing.projectUuid ? { projectUuid: routing.projectUuid } : {}),
  });
  // Validate existing inline config before mutating either config file. The
  // runtime override also prevents an old project whitelist or URL from
  // overriding the catalog and credentials chosen for this launch.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPPER_CLI_LAUNCH_OPENCODE: "1",
    OPPER_API_KEY: routing.apiKey,
    OPENCODE_CONFIG_CONTENT: runtimeConfig(models, routing),
  };
  delete env.OPPER_CLI_EFFORT_POLICY;
  let effortDirectory: string | undefined;
  // An installed login bridge can also sanitize client-inferred request
  // defaults during launch. Policy stays on disk rather than in a large env.
  try {
    if (existsSync(openCodeLoginBridgePath())) {
      effortDirectory = mkdtempSync(join(tmpdir(), "opper-opencode-effort-policy-"));
      env.OPPER_CLI_EFFORT_POLICY = join(effortDirectory, "models.json");
      await writeFile(env.OPPER_CLI_EFFORT_POLICY, JSON.stringify(models), { mode: 0o600 });
    }
    const majorVersion = openCodeMajorVersion(env);
    checkEffectiveAuthorization(models, env, routing.projectUuid, majorVersion);
    const launchArgs = majorVersion !== undefined && majorVersion >= 2 ? withStandaloneServer(args) : args;

    if (scope === "project") {
      // `--project` is opt-in to a persistent, usually-checked-in project
      // config. Reverting the whole opper provider on exit would defeat
      // the point — instead we apply the session URL only for the spawn
      // and reset baseURL afterwards. The opper provider block stays in
      // place across launches.
      //
      // Capture restoreUrl *before* configureOpenCode runs, since
      // `overwrite: true` replaces provider.opper with template values
      // (compat URL) — capturing after would discard a hand-edited
      // self-hosted baseURL.
      const restoreUrl = restoreTarget(readBaseUrl("local"));
      await configureOpenCode({ location: "local", overwrite: true, ...(models ? { models } : {}) });
      await setSessionBaseUrl(routing.baseUrl, "local");
      try {
        checkEffectiveEfforts(models, checkEffectiveAuthorization(models, env, routing.projectUuid, majorVersion));
        const result = spawnSync("opencode", launchArgs, { stdio: "inherit", env });
        return result.status ?? -1;
      } finally {
        await setSessionBaseUrl(restoreUrl, "local");
      }
    }

    // User-scope: snapshot the Opper-owned keys. The template writes
    // `provider.opper`, a top-level `model: "opper/..."`, AND a top-level
    // `$schema` — all three need narrow restore. Without `$schema`, a
    // fresh first launch leaves a `{"$schema": "..."}` file behind even
    // though it's meant to be ephemeral. Without `model`, an orphaned
    // `model: "opper/..."` points at a removed provider. OpenCode mutates
    // sibling keys (theme, MCP servers, …) during a session — those are
    // outside our keyPaths and survive the restore.
    return await withJsonKeys(
      opencodeConfigPath("global"),
      [["provider", "opper"], ["model"], ["$schema"]],
      async () => {
        await configureOpenCode({ location: "global", overwrite: true, ...(models ? { models } : {}) });

        await setSessionBaseUrl(routing.baseUrl, "global");
        checkEffectiveEfforts(models, checkEffectiveAuthorization(models, env, routing.projectUuid, majorVersion));
        const result = spawnSync("opencode", launchArgs, { stdio: "inherit", env });
        return result.status ?? -1;
      },
    );
  } finally {
    if (effortDirectory) rmSync(effortDirectory, { recursive: true, force: true });
  }
}

export const opencode: AgentAdapter = {
  name: "opencode",
  displayName: "OpenCode",
  docsUrl: "https://opencode.ai",
  detect,
  isConfigured,
  configure,
  unconfigure,
  install,
  spawn,
};
