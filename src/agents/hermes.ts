import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, rename, chmod } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { which } from "../util/which.js";
import { run } from "../util/run.js";
import { takeSnapshot, restoreSnapshot, rotateBackups } from "../util/backup.js";
import { OpperError } from "../errors.js";
import type {
  AgentAdapter,
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
    throw new Error(`Hermes installer exited with code ${result.code}`);
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
  parsed.model = {
    provider: c.compatShape === "openai" ? "openai" : c.compatShape,
    model: c.model,
    base_url: c.baseUrl,
    api_key: c.apiKey,
  };
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, stringify(parsed), "utf8");
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

async function restoreConfig(h: SnapshotHandle): Promise<void> {
  await restoreSnapshot(h, hermesConfigPath());
}

async function spawn(args: string[]): Promise<number> {
  const result = run("hermes", args, { inherit: true });
  return result.code;
}

export const hermes: AgentAdapter = {
  name: "hermes",
  displayName: "Hermes Agent",
  binary: "hermes",
  docsUrl: "https://hermes-agent.nousresearch.com/docs/",
  detect,
  install,
  snapshotConfig,
  writeOpperConfig,
  restoreConfig,
  spawn,
};
