import { join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parse, stringify } from "yaml";
import { which } from "../util/which.js";
import { run } from "../util/run.js";
import { opperHome } from "../auth/paths.js";
import { OpperError } from "../errors.js";
import { PICKER_MODELS } from "../config/models.js";
import { assetPath } from "../util/assets.js";
import type {
  AgentAdapter,
  DetectResult,
  OpperRouting,
} from "./types.js";

/**
 * Opper-managed HERMES_HOME root. Each `opper launch hermes` runs against
 * this isolated directory: the user's main `~/.hermes/` is never read or
 * mutated. Skills, sessions, and caches persist across launches inside it.
 */
function hermesHome(): string {
  return join(opperHome(), "hermes-home");
}

function hermesConfigPath(): string {
  return join(hermesHome(), "config.yaml");
}

async function detect(): Promise<DetectResult> {
  const path = await which("hermes");
  if (!path) return { installed: false };

  const versionResult = run("hermes", ["--version"]);
  // Pull a semver-shaped token from stdout. Avoids false positives from
  // help text like "hermes vupdate available".
  const versionMatch = versionResult.code === 0
    ? versionResult.stdout.match(/v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/)
    : null;
  const parsed = versionMatch ? versionMatch[1] : undefined;

  return {
    installed: true,
    ...(parsed ? { version: parsed } : {}),
    configPath: hermesConfigPath(),
  };
}

async function install(): Promise<void> {
  const result = run(
    "bash",
    ["-c", "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash"],
    { inherit: true },
  );
  if (result.code !== 0) {
    throw new OpperError(
      "AGENT_NOT_FOUND",
      `Hermes installer exited with code ${result.code}`,
      "Check your network connection and try again, or follow the manual install steps at https://hermes-agent.nousresearch.com/docs/",
    );
  }
}

async function isConfigured(): Promise<boolean> {
  return (await detect()).installed;
}

async function configure(): Promise<void> {
  if (!(await detect()).installed) {
    throw new OpperError(
      "AGENT_NOT_FOUND",
      "Hermes is not installed",
      "Run `opper launch hermes --install`, or install manually from https://hermes-agent.nousresearch.com/docs/.",
    );
  }
}

async function unconfigure(): Promise<void> {
  // Nothing persistent in the user's environment — the Opper-managed
  // HERMES_HOME is only touched at launch time.
}

/**
 * Writes the minimum config Hermes needs to talk to Opper. Hermes (since
 * v0.5+) refuses to honour `OPENAI_BASE_URL` from the environment — the
 * base URL must live in config.yaml — so we bake it into our isolated
 * HERMES_HOME before each launch. The api key is passed via OPPER_API_KEY
 * env at spawn time so the secret never lands on disk.
 */
async function writeOpperConfig(routing: OpperRouting): Promise<void> {
  const home = hermesHome();
  await mkdir(home, { recursive: true });

  const path = hermesConfigPath();
  // Preserve any non-model settings the user might have customised in this
  // Opper-managed home (toolsets, agent preferences, …). Only the model
  // block is owned by us.
  const existing: Record<string, unknown> = existsSync(path)
    ? ((parse(await readFile(path, "utf8")) as Record<string, unknown>) ?? {})
    : {};
  existing.model = {
    provider: "opper",
    base_url: routing.baseUrl,
    default: routing.model,
  };

  // `model.provider` and the providers entry must share the same key. Hermes
  // resolves the request-time api key from the ACTIVE provider's `key_env`, so
  // a mismatch (e.g. provider "custom" but config under "opper") leaves the
  // active provider with no key and Hermes sends a "no-key-required" placeholder
  // that Opper rejects with 401. The shipped `opper` provider plugin
  // (writeOpperPlugin) registers a matching profile so this name resolves and
  // the session/affinity headers are emitted; it also makes the `/model` picker
  // show "Opper (N models)".
  //
  // The curated `models:` dict is the fallback Hermes uses when live discovery
  // from `<base_url>/v1/models` fails. `key_env: OPPER_API_KEY` matches the env
  // we export at spawn, so no api key lands on disk. We use a dedicated env name
  // (not OPENAI_API_KEY) so the launch never clobbers the user's real OpenAI key.
  const opperModels: Record<string, Record<string, never>> = {};
  for (const m of PICKER_MODELS) opperModels[m.id] = {};
  const providers = (existing.providers as Record<string, unknown> | undefined) ?? {};
  providers.opper = {
    name: "Opper",
    base_url: routing.baseUrl,
    key_env: "OPPER_API_KEY",
    models: opperModels,
  };
  existing.providers = providers;

  await writeFile(path, stringify(existing), { mode: 0o600 });
}

/**
 * Install the Opper provider plugin into the isolated HERMES_HOME. It registers
 * the `opper` provider (the one `writeOpperConfig` selects) and emits the
 * per-session `X-Opper-Trace-Id` / `X-Opper-Parent-Span-Id` headers that drive
 * provider affinity and the session-root span tree. Rewritten each launch so
 * CLI upgrades ship plugin changes.
 */
async function writeOpperPlugin(home: string): Promise<void> {
  const dir = join(home, "plugins", "model-providers", "opper");
  await mkdir(dir, { recursive: true });
  for (const file of ["__init__.py", "plugin.yaml"]) {
    const contents = await readFile(assetPath(join("hermes-opper-plugin", file)), "utf8");
    await writeFile(join(dir, file), contents, { mode: 0o644 });
  }
}

async function spawn(args: string[], routing: OpperRouting): Promise<number> {
  await writeOpperConfig(routing);
  await writeOpperPlugin(hermesHome());

  const result = run("hermes", args, {
    inherit: true,
    env: {
      ...process.env,
      HERMES_HOME: hermesHome(),
      OPPER_API_KEY: routing.apiKey,
    },
  });
  return result.code;
}

export const hermes: AgentAdapter = {
  name: "hermes",
  displayName: "Hermes Agent",
  docsUrl: "https://hermes-agent.nousresearch.com/docs/",
  detect,
  isConfigured,
  configure,
  unconfigure,
  install,
  spawn,
};
