import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { which } from "../util/which.js";
import { run } from "../util/run.js";
import { OpperError } from "../errors.js";
import { OPPER_COMPAT_URL } from "../config/endpoints.js";
import { DEFAULT_MODELS } from "../config/models.js";
import type {
  AgentAdapter,
  ConfigureOptions,
  DetectResult,
  OpperRouting,
} from "./types.js";

// We own the `opper` provider key inside OpenClaw's per-agent models.json.
// Anything else in the file is the user's own configuration and stays put.
const PROVIDER_KEY = "opper";
const AGENT_NAME = "main";

interface ModelsFile {
  providers?: Record<string, unknown>;
  [k: string]: unknown;
}

function modelsPath(): string {
  return join(homedir(), ".openclaw", "agents", AGENT_NAME, "agent", "models.json");
}

async function readConfig(): Promise<ModelsFile> {
  const cfg = modelsPath();
  if (!existsSync(cfg)) return {};
  try {
    return JSON.parse(await readFile(cfg, "utf8")) as ModelsFile;
  } catch {
    return {};
  }
}

async function writeConfig(data: ModelsFile): Promise<void> {
  const cfg = modelsPath();
  await mkdir(dirname(cfg), { recursive: true });
  await writeFile(cfg, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

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
        name: launchModel,
        api: "openai-completions",
        reasoning: true,
        input: ["text"],
        contextWindow: 200000,
      },
      {
        id: DEFAULT_MODELS.sonnet,
        name: DEFAULT_MODELS.sonnet,
        api: "openai-completions",
        reasoning: true,
        input: ["text"],
        contextWindow: 200000,
      },
      {
        id: DEFAULT_MODELS.haiku,
        name: DEFAULT_MODELS.haiku,
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        contextWindow: 200000,
      },
    ],
  };
  await writeConfig(cfg);
}

async function detect(): Promise<DetectResult> {
  const path = await which("openclaw");
  if (!path) return { installed: false };

  const versionResult = run("openclaw", ["--version"]);
  const versionMatch = versionResult.code === 0
    ? versionResult.stdout.match(/v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/)
    : null;
  const parsed = versionMatch ? versionMatch[1] : undefined;

  return {
    installed: true,
    ...(parsed ? { version: parsed } : {}),
    configPath: modelsPath(),
  };
}

async function install(): Promise<void> {
  throw new OpperError(
    "AGENT_NOT_FOUND",
    "OpenClaw must be installed manually.",
    "Install via `npm i -g openclaw` or see https://docs.openclaw.ai.",
  );
}

async function isConfigured(): Promise<boolean> {
  const cfg = await readConfig();
  return Boolean(cfg.providers && cfg.providers[PROVIDER_KEY]);
}

async function configure(opts: ConfigureOptions): Promise<void> {
  if (!opts.apiKey) {
    throw new OpperError(
      "AUTH_REQUIRED",
      "OpenClaw configuration needs an Opper API key.",
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
  // Ensure our provider is current with the latest credentials and the
  // chosen launch model on every spawn.
  await setOpperProvider(routing.apiKey, routing.model);

  // OpenClaw is a gateway/daemon, not an interactive REPL. Default to
  // `gateway start` — installs/starts the background service via
  // launchd/systemd, returns quickly, and the gateway keeps serving
  // chat channels in the background. This matches what Ollama does
  // when launching OpenClaw from its own menu.
  //
  // Pass-through args take over from the default so users can run a
  // different OpenClaw entry point through Opper too:
  //   opper launch openclaw -- agent --local -m "summarise ..."
  //   opper launch openclaw -- gateway run     # foreground if you
  //                                            # really want it
  const finalArgs = args.length > 0 ? args : ["gateway", "start"];
  const result = spawnSync("openclaw", finalArgs, { stdio: "inherit" });

  if (args.length === 0 && result.status === 0) {
    console.log(
      "\nOpenClaw gateway started in the background.\n" +
        "  Stop it with:  openclaw gateway stop\n" +
        "  Status:        openclaw gateway status\n" +
        "  Logs:          openclaw logs\n",
    );
  }
  return result.status ?? -1;
}

export const openclaw: AgentAdapter = {
  name: "openclaw",
  displayName: "OpenClaw",
  docsUrl: "https://docs.openclaw.ai",
  detect,
  isConfigured,
  configure,
  unconfigure,
  install,
  spawn,
};
