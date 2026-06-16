import { join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { which } from "../util/which.js";
import { run } from "../util/run.js";
import { opperHome } from "../auth/paths.js";
import { OpperError } from "../errors.js";
import { npmInstallGlobal } from "./npm-install.js";
import { pickerModelsForLaunch } from "../config/models.js";
import { assetPath } from "../util/assets.js";
import type {
  AgentAdapter,
  DetectResult,
  OpperRouting,
} from "./types.js";

// The provider key we own inside the isolated pi home's models.json.
const PROVIDER_KEY = "opper";

/**
 * Opper-managed PI_CODING_AGENT_DIR. Each `opper launch pi` runs against this
 * isolated home: the user's real ~/.pi/agent is never read or mutated. The
 * `opper` provider config and the session extension live here, so there's no
 * snapshot/restore dance and no risk to the user's own pi setup.
 */
function piHome(): string {
  return join(opperHome(), "pi-home");
}

function piConfigPath(): string {
  return join(piHome(), "models.json");
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
  // Routing is applied at launch into the isolated home, so "configured"
  // collapses to "installed" (mirrors the Hermes adapter).
  return (await detect()).installed;
}

async function configure(): Promise<void> {
  if (!(await detect()).installed) {
    throw new OpperError(
      "AGENT_NOT_FOUND",
      "Pi is not installed",
      "Run `opper launch pi --install`, or install manually from https://pi.dev.",
    );
  }
}

async function unconfigure(): Promise<void> {
  // Nothing persistent in the user's environment — the Opper-managed
  // PI_CODING_AGENT_DIR is only touched at launch time.
}

/**
 * Write the minimum config pi needs to talk to Opper into the isolated home: a
 * single `opper` provider (openai-completions shape) with the launch models.
 * The api key stays in OPPER_API_KEY (exported at spawn) — referenced here as
 * `$OPPER_API_KEY` so the secret never lands on disk. Per-session trace headers
 * are added by the shipped extension (writeOpperExtension), not baked in here.
 */
async function writeOpperConfig(routing: OpperRouting): Promise<void> {
  const home = piHome();
  await mkdir(home, { recursive: true });

  // The launch model sits at index 0 (pi treats the first entry as the active
  // default in its picker) and is marked with `_launch: true`.
  const cfg = {
    providers: {
      [PROVIDER_KEY]: {
        api: "openai-completions",
        apiKey: "$OPPER_API_KEY",
        baseUrl: routing.baseUrl,
        models: pickerModelsForLaunch(routing.model).map((m) => ({
          id: m.id,
          contextWindow: m.contextWindow,
          input: ["text"],
          reasoning: m.reasoning,
          ...(m.id === routing.model ? { _launch: true } : {}),
        })),
      },
    },
  };
  await writeFile(piConfigPath(), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Install the Opper session extension into the isolated home so pi
 * auto-discovers it. It re-registers the `opper` provider on each session
 * boundary with per-session `X-Opper-Trace-Id` / `X-Opper-Parent-Span-Id`
 * headers — so every pi session (a /new, /resume, /fork, /reset, or a child pi
 * process) becomes its own session-root tree. Rewritten each launch so CLI
 * upgrades ship extension changes.
 */
async function writeOpperExtension(home: string): Promise<void> {
  const dir = join(home, "extensions");
  await mkdir(dir, { recursive: true });
  const contents = await readFile(
    assetPath(join("pi-opper-extension", "opper-session.ts")),
    "utf8",
  );
  await writeFile(join(dir, "opper-session.ts"), contents, { mode: 0o644 });
}

async function spawn(args: string[], routing: OpperRouting): Promise<number> {
  await writeOpperConfig(routing);
  await writeOpperExtension(piHome());

  // pi's CLI requires *both* --provider and --model to resolve a non-default
  // provider — passing only --provider falls through to the auto-resolver and
  // silently picks the first available provider.
  const userPicked = args.some(
    (a) => a === "--model" || a === "-m" || a.startsWith("--model="),
  );
  const piArgs = userPicked
    ? ["--provider", PROVIDER_KEY, ...args]
    : ["--provider", PROVIDER_KEY, "--model", routing.model, ...args];

  // PI_CODING_AGENT_DIR points pi at the isolated home; OPPER_API_KEY /
  // OPPER_BASE_URL feed both the config's `$OPPER_API_KEY` and the extension's
  // per-session provider re-registration. The key never lands on disk.
  const result = run("pi", piArgs, {
    inherit: true,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: piHome(),
      OPPER_API_KEY: routing.apiKey,
      OPPER_BASE_URL: routing.baseUrl,
    },
  });
  return result.code;
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
