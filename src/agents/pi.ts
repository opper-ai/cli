import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { which } from "../util/which.js";
import { run } from "../util/run.js";
import { OpperError } from "../errors.js";
import { npmInstallGlobal } from "./npm-install.js";
import { OPPER_COMPAT_URL } from "../config/endpoints.js";
import { DEFAULT_MODELS } from "../config/models.js";
import type {
  AgentAdapter,
  ConfigureOptions,
  DetectResult,
  OpperRouting,
} from "./types.js";

// The provider key we own inside ~/.pi/agent/models.json. Anything outside
// this key is the user's own configuration and stays untouched.
const PROVIDER_KEY = "opper";

interface PiModelsFile {
  providers?: Record<string, unknown>;
  [k: string]: unknown;
}

function piConfigPath(): string {
  return join(homedir(), ".pi", "agent", "models.json");
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
 * Idempotently install our `opper` provider entry. Other providers in the
 * same file (ollama, etc.) are preserved.
 */
async function setOpperProvider(apiKey: string, launchModel: string): Promise<void> {
  const cfg = await readConfig();
  cfg.providers = cfg.providers ?? {};
  cfg.providers[PROVIDER_KEY] = {
    api: "openai-completions",
    apiKey,
    baseUrl: OPPER_COMPAT_URL,
    models: [
      {
        id: launchModel,
        contextWindow: 200000,
        input: ["text"],
        reasoning: true,
        _launch: true,
      },
      {
        id: DEFAULT_MODELS.sonnet,
        contextWindow: 200000,
        input: ["text"],
        reasoning: true,
      },
      {
        id: DEFAULT_MODELS.haiku,
        contextWindow: 200000,
        input: ["text"],
        reasoning: false,
      },
    ],
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
  await setOpperProvider(opts.apiKey, DEFAULT_MODELS.opus);
}

async function unconfigure(): Promise<void> {
  const cfg = await readConfig();
  if (cfg.providers && cfg.providers[PROVIDER_KEY]) {
    delete cfg.providers[PROVIDER_KEY];
    await writeConfig(cfg);
  }
}

async function spawn(args: string[], routing: OpperRouting): Promise<number> {
  // Re-write the provider on every launch so the latest credentials and the
  // chosen launch model are always the active ones.
  await setOpperProvider(routing.apiKey, routing.model);

  // pi's CLI requires *both* --provider and --model to resolve a non-default
  // provider — passing only --provider falls through to the auto-resolver
  // and silently picks the first available provider (usually ollama).
  const userPicked = args.some(
    (a) => a === "--model" || a === "-m" || a.startsWith("--model="),
  );
  const piArgs = userPicked
    ? ["--provider", PROVIDER_KEY, ...args]
    : ["--provider", PROVIDER_KEY, "--model", routing.model, ...args];
  const result = spawnSync("pi", piArgs, { stdio: "inherit" });
  return result.status ?? -1;
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
