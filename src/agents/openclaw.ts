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
import { DEFAULT_MODELS, pickerModelsForLaunch } from "../config/models.js";
import { withJsonKeys } from "../util/config-snapshot.js";
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

async function setOpperProvider(
  apiKey: string,
  launchModel: string,
  baseUrl: string,
): Promise<void> {
  const cfg = await readConfig();
  cfg.providers = cfg.providers ?? {};
  // The launch model is reordered to index 0 — OpenClaw has no explicit
  // _launch marker, so position-0 is the only signal that picks the
  // active default in its picker UI.
  cfg.providers[PROVIDER_KEY] = {
    api: "openai-completions",
    apiKey,
    baseUrl,
    models: pickerModelsForLaunch(launchModel).map((m) => ({
      id: m.id,
      name: m.id,
      api: "openai-completions",
      reasoning: m.reasoning,
      input: ["text"],
      contextWindow: m.contextWindow,
    })),
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
  await npmInstallGlobal("openclaw", "https://docs.openclaw.ai");
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
  await setOpperProvider(opts.apiKey, DEFAULT_MODELS.opus, OPPER_COMPAT_URL);
}

async function unconfigure(): Promise<void> {
  const cfg = await readConfig();
  if (cfg.providers && cfg.providers[PROVIDER_KEY]) {
    delete cfg.providers[PROVIDER_KEY];
    await writeConfig(cfg);
  }
}

async function spawn(args: string[], routing: OpperRouting): Promise<number> {
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
  // Detect daemon launches by subcommand, not arg count: `opper launch
  // openclaw` (no args, defaults to `gateway start`) AND `opper launch
  // openclaw -- gateway start` / `-- daemon start` all detach a
  // long-lived service that outlives spawnSync.
  const finalArgs = args.length === 0 ? ["gateway", "start"] : args;
  const isDaemonStart =
    finalArgs.length >= 2 &&
    (finalArgs[0] === "gateway" || finalArgs[0] === "daemon") &&
    finalArgs[1] === "start";

  // Snapshot/restore only fits one-shot synchronous invocations. For the
  // daemon path, `spawnSync` returns as soon as the gateway detaches —
  // restoring models.json then would either break the running gateway's
  // routing (if it re-reads the file) or be cosmetic at best (if it
  // cached at startup). Leave the file as-is for that path; the daemon
  // owns its lifecycle and the user controls it via `gateway stop/start`.
  //
  // Trade-off: a direct `openclaw gateway start` run *after* an `opper
  // launch openclaw` (without `opper launch` in front) will pick up the
  // session-tagged URL until the next `opper launch` or `opper agents
  // add openclaw` rewrites it. Acceptable — direct gateway use after a
  // launch is rare, and the leak only persists in that narrow window.
  if (isDaemonStart) {
    await setOpperProvider(routing.apiKey, routing.model, routing.baseUrl);
    const result = spawnSync("openclaw", finalArgs, { stdio: "inherit" });
    if (result.status === 0) {
      console.log(
        "\nOpenClaw gateway started in the background.\n" +
          "  Stop it with:  openclaw gateway stop\n" +
          "  Status:        openclaw gateway status\n" +
          "  Logs:          openclaw logs\n",
      );
    }
    return result.status ?? -1;
  }

  // Snapshot just `providers.opper` so direct `openclaw` invocations
  // after the launch don't inherit this session's URL — and so any
  // sibling providers / top-level keys the user edits mid-spawn aren't
  // clobbered on restore.
  return withJsonKeys(modelsPath(), [["providers", PROVIDER_KEY]], async () => {
    await setOpperProvider(routing.apiKey, routing.model, routing.baseUrl);
    const result = spawnSync("openclaw", finalArgs, { stdio: "inherit" });
    return result.status ?? -1;
  });
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
