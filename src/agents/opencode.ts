import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { which } from "../util/which.js";
import { configureOpenCode } from "../setup/opencode.js";
import { OpperError } from "../errors.js";
import type {
  AgentAdapter,
  DetectResult,
  OpperRouting,
  SnapshotHandle,
} from "./types.js";

// Stateful bridge between writeOpperConfig and spawn. The launch flow calls
// these in sequence on the same process, so module-level state is safe.
let pendingRouting: OpperRouting | null = null;

function opencodeConfigPath(): string {
  return join(homedir(), ".config", "opencode", "opencode.json");
}

async function detect(): Promise<DetectResult> {
  const binaryPath = await which("opencode");
  if (!binaryPath) return { installed: false };
  const cfg = opencodeConfigPath();
  return {
    installed: true,
    ...(existsSync(cfg) ? { configPath: cfg } : {}),
  };
}

async function install(): Promise<void> {
  throw new OpperError(
    "AGENT_NOT_FOUND",
    "OpenCode must be installed manually.",
    "See https://opencode.ai for install instructions, then retry.",
  );
}

async function snapshotConfig(): Promise<SnapshotHandle> {
  // OpenCode's config reads the API key from the `OPPER_API_KEY` env var, so
  // nothing on disk needs mutating. Return a zero-sized handle.
  return {
    agent: "opencode",
    backupPath: "",
    timestamp: new Date().toISOString(),
  };
}

async function writeOpperConfig(c: OpperRouting): Promise<void> {
  // Ensure the Opper provider block exists in the user's opencode config
  // (first-launch ergonomics). No-op if it's already there.
  await configureOpenCode({ location: "global" });
  pendingRouting = c;
}

async function restoreConfig(_h: SnapshotHandle): Promise<void> {
  pendingRouting = null;
}

async function spawn(args: string[]): Promise<number> {
  const routing = pendingRouting;
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (routing) {
    env.OPPER_API_KEY = routing.apiKey;
  }
  const result = spawnSync("opencode", args, { stdio: "inherit", env });
  return result.status ?? -1;
}

export const opencode: AgentAdapter = {
  name: "opencode",
  displayName: "OpenCode",
  binary: "opencode",
  docsUrl: "https://opencode.ai",
  detect,
  install,
  snapshotConfig,
  writeOpperConfig,
  restoreConfig,
  spawn,
};
