import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { which } from "../util/which.js";
import { run } from "../util/run.js";
import { OpperError } from "../errors.js";
import { npmInstallGlobal } from "./npm-install.js";
import { OPPER_COMPAT_URL } from "../config/endpoints.js";
import { DEFAULT_MODELS, pickerModelsForLaunch } from "../config/models.js";
import { withJsonKeys } from "../util/config-snapshot.js";
import { assetPath } from "../util/assets.js";
import type {
  AgentAdapter,
  ConfigureOptions,
  DetectResult,
  OpperRouting,
} from "./types.js";

// The provider key we own inside ~/.pi/agent/models.json. Everything else in
// the user's pi home — skills, settings, MCP servers, other providers — is
// theirs and is loaded normally; we never run pi against an isolated home.
const PROVIDER_KEY = "opper";

function piAgentDir(): string {
  return join(homedir(), ".pi", "agent");
}
function piConfigPath(): string {
  return join(piAgentDir(), "models.json");
}
function piExtensionPath(): string {
  return join(piAgentDir(), "extensions", "opper-session.ts");
}

interface PiModelsFile {
  providers?: Record<string, unknown>;
  [k: string]: unknown;
}

async function readConfig(): Promise<PiModelsFile> {
  const cfg = piConfigPath();
  if (!existsSync(cfg)) return {};
  try {
    return JSON.parse(await readFile(cfg, "utf8")) as PiModelsFile;
  } catch {
    return {};
  }
}

async function writeConfig(data: PiModelsFile): Promise<void> {
  const cfg = piConfigPath();
  await mkdir(dirname(cfg), { recursive: true });
  await writeFile(cfg, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Idempotently install our `opper` provider entry. Other providers in the same
 * file (ollama, etc.) are preserved. Per-session trace headers are added by the
 * shipped extension (writeExtension), not baked in here.
 */
async function setOpperProvider(
  apiKey: string,
  launchModel: string,
  baseUrl: string,
): Promise<void> {
  const cfg = await readConfig();
  cfg.providers = cfg.providers ?? {};
  // The launch model is reordered to index 0 (pi treats the first entry as the
  // active default in its picker UI). `_launch: true` is the explicit marker.
  cfg.providers[PROVIDER_KEY] = {
    api: "openai-completions",
    apiKey,
    baseUrl,
    models: pickerModelsForLaunch(launchModel).map((m) => ({
      id: m.id,
      contextWindow: m.contextWindow,
      input: ["text"],
      reasoning: m.reasoning,
      ...(m.id === launchModel ? { _launch: true } : {}),
    })),
  };
  await writeConfig(cfg);
}

async function detect(): Promise<DetectResult> {
  const path = await which("pi");
  if (!path) return { installed: false };

  const versionResult = run("pi", ["--version"]);
  const versionMatch = versionResult.code === 0
    ? versionResult.stdout.match(/v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/)
    : null;
  const parsed = versionMatch ? versionMatch[1] : undefined;

  return {
    installed: true,
    ...(parsed ? { version: parsed } : {}),
    configPath: piConfigPath(),
  };
}

async function install(): Promise<void> {
  await npmInstallGlobal("@mariozechner/pi-coding-agent", "https://pi.dev");
}

async function isConfigured(): Promise<boolean> {
  const cfg = await readConfig();
  return Boolean(cfg.providers && cfg.providers[PROVIDER_KEY]);
}

async function configure(opts: ConfigureOptions): Promise<void> {
  if (!opts.apiKey) {
    throw new OpperError(
      "AUTH_REQUIRED",
      "Pi configuration needs an Opper API key.",
      "Run `opper login` first, or set OPPER_API_KEY.",
    );
  }
  await setOpperProvider(opts.apiKey, DEFAULT_MODELS.opus, OPPER_COMPAT_URL);
}

async function unconfigure(): Promise<void> {
  const cfg = await readConfig();
  if (cfg.providers && cfg.providers[PROVIDER_KEY]) {
    delete cfg.providers[PROVIDER_KEY];
    await writeConfig(cfg);
  }
  // Drop the session extension if a previous launch left it behind.
  await rm(piExtensionPath(), { force: true });
}

/**
 * Ship the Opper session extension into the user's real pi home so pi
 * auto-discovers it, and return a restore fn. The extension re-registers the
 * `opper` provider on each session boundary with per-session trace headers — so
 * every pi session (a /new, /resume, /fork, /reset, or a child pi process) gets
 * its own session-root tree. It is a no-op unless OPPER_API_KEY / OPPER_BASE_URL
 * are set, so it can't disturb the user's own pi sessions.
 *
 * Snapshot/restore mirrors the provider's: a one-off `opper launch pi` leaves
 * nothing behind, and any pre-existing file of the same name is put back.
 */
async function installExtension(): Promise<() => Promise<void>> {
  const file = piExtensionPath();
  const dir = dirname(file);
  const dirExisted = existsSync(dir);
  const prior = existsSync(file) ? await readFile(file, "utf8") : null;

  await mkdir(dir, { recursive: true });
  const contents = await readFile(
    assetPath(join("pi-opper-extension", "opper-session.ts")),
    "utf8",
  );
  await writeFile(file, contents, { mode: 0o644 });

  return async () => {
    try {
      if (prior !== null) {
        await writeFile(file, prior, { mode: 0o644 });
      } else {
        await rm(file, { force: true });
        if (!dirExisted) await rm(dir, { recursive: true, force: true });
      }
    } catch (err) {
      process.stderr.write(
        `opper: failed to restore ${file} after launch: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  };
}

async function spawn(args: string[], routing: OpperRouting): Promise<number> {
  // Snapshot just `providers.opper` so direct `pi` invocations after the launch
  // don't inherit this session's URL, and the user's other providers / top-level
  // keys survive intact. The extension is snapshot/restored separately.
  return withJsonKeys(piConfigPath(), [["providers", PROVIDER_KEY]], async () => {
    // Write the api key as the `$OPPER_API_KEY` env reference, not the literal —
    // pi resolves it from the env we export below, and the extension re-registers
    // from the same env, so the real key never lands in the user's config on disk.
    await setOpperProvider("$OPPER_API_KEY", routing.model, routing.baseUrl);
    const restoreExtension = await installExtension();
    try {
      // pi's CLI requires *both* --provider and --model to resolve a non-default
      // provider — passing only --provider falls through to the auto-resolver.
      const userPicked = args.some(
        (a) => a === "--model" || a === "-m" || a.startsWith("--model="),
      );
      const piArgs = userPicked
        ? ["--provider", PROVIDER_KEY, ...args]
        : ["--provider", PROVIDER_KEY, "--model", routing.model, ...args];

      // OPPER_API_KEY / OPPER_BASE_URL feed the extension's per-session provider
      // re-registration (a partial { headers } registration drops apiKey/baseUrl,
      // so it re-supplies both from the env).
      const result = run("pi", piArgs, {
        inherit: true,
        env: {
          ...process.env,
          OPPER_API_KEY: routing.apiKey,
          OPPER_BASE_URL: routing.baseUrl,
        },
      });
      return result.code;
    } finally {
      await restoreExtension();
    }
  });
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
