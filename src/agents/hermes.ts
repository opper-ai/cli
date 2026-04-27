import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, rename, chmod, rm } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { which } from "../util/which.js";
import { run } from "../util/run.js";
import { takeSnapshot, restoreSnapshot, rotateBackups } from "../util/backup.js";
import { OpperError } from "../errors.js";
import type {
  LaunchableAgentAdapter,
  DetectResult,
  OpperRouting,
  SnapshotHandle,
} from "./types.js";

function hermesConfigPath(): string {
  return join(homedir(), ".hermes", "config.yaml");
}

async function detect(): Promise<DetectResult> {
  const path = await which("hermes");
  if (!path) return { installed: false };

  const versionResult = run("hermes", ["--version"]);
  const parsed = versionResult.code === 0
    ? versionResult.stdout.trim().split(/\s+/).pop()
    : undefined;

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

async function snapshotConfig(): Promise<SnapshotHandle> {
  const path = hermesConfigPath();
  if (!existsSync(path)) {
    throw new OpperError(
      "AGENT_CONFIG_CONFLICT",
      `Hermes config not found at ${path}`,
      "Run `hermes` once to initialise a config, then try again.",
    );
  }
  const handle = await takeSnapshot("hermes", path);
  await rotateBackups("hermes", 20);
  return handle;
}

async function writeOpperConfig(c: OpperRouting): Promise<void> {
  const path = hermesConfigPath();
  const raw = await readFile(path, "utf8");
  const parsed = (parse(raw) as Record<string, unknown>) ?? {};
  // Hermes recognises "openai" / "anthropic" providers. The Opper "responses"
  // compat shape isn't a Hermes provider — callers today only pass "openai";
  // if that changes, add a guard here.
  parsed.model = {
    provider: c.compatShape === "openai" ? "openai" : c.compatShape,
    model: c.model,
    base_url: c.baseUrl,
    api_key: c.apiKey,
  };
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, stringify(parsed), "utf8");
  try {
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function restoreConfig(h: SnapshotHandle): Promise<void> {
  await restoreSnapshot(h, hermesConfigPath());
}

async function spawn(args: string[]): Promise<number> {
  const result = run("hermes", args, { inherit: true });
  return result.code;
}

async function isConfigured(): Promise<boolean> {
  // Hermes auto-configures at every launch (snapshot → write → restore),
  // so "configured" collapses to "installed".
  const r = await detect();
  return r.installed;
}

async function configure(): Promise<void> {
  const r = await detect();
  if (!r.installed) {
    throw new OpperError(
      "AGENT_NOT_FOUND",
      "Hermes is not installed",
      "Run `opper launch hermes --install`, or install manually from https://hermes-agent.nousresearch.com/docs/.",
    );
  }
  // No persistent config to write — launch handles it.
}

async function unconfigure(): Promise<void> {
  // Hermes has no persistent Opper bits to remove (launch does
  // snapshot → write → restore on every run). Nothing to do.
}

export const hermes: LaunchableAgentAdapter = {
  name: "hermes",
  displayName: "Hermes Agent",
  binary: "hermes",
  docsUrl: "https://hermes-agent.nousresearch.com/docs/",
  launchable: true,
  detect,
  isConfigured,
  configure,
  unconfigure,
  install,
  snapshotConfig,
  writeOpperConfig,
  restoreConfig,
  spawn,
};
