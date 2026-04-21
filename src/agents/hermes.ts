import { homedir } from "node:os";
import { join } from "node:path";
import { which } from "../util/which.js";
import { run } from "../util/run.js";
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
  throw new Error("snapshotConfig not yet implemented");
}

async function writeOpperConfig(_c: OpperRouting): Promise<void> {
  throw new Error("writeOpperConfig not yet implemented");
}

async function restoreConfig(_h: SnapshotHandle): Promise<void> {
  throw new Error("restoreConfig not yet implemented");
}

async function spawn(_args: string[]): Promise<number> {
  throw new Error("spawn not yet implemented");
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
