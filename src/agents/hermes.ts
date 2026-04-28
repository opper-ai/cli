import { join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parse, stringify } from "yaml";
import { which } from "../util/which.js";
import { run } from "../util/run.js";
import { opperHome } from "../auth/paths.js";
import { OpperError } from "../errors.js";
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
 * HERMES_HOME before each launch. The api key is passed via OPENAI_API_KEY
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
    provider: "custom",
    base_url: routing.baseUrl,
    default: routing.model,
  };

  await writeFile(path, stringify(existing), { mode: 0o600 });
}

async function spawn(args: string[], routing: OpperRouting): Promise<number> {
  await writeOpperConfig(routing);

  const result = run("hermes", args, {
    inherit: true,
    env: {
      ...process.env,
      HERMES_HOME: hermesHome(),
      OPENAI_API_KEY: routing.apiKey,
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
