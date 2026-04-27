import { spawnSync } from "node:child_process";
import { which } from "../util/which.js";
import { OpperError } from "../errors.js";
import type {
  LaunchableAgentAdapter,
  DetectResult,
  OpperRouting,
  SnapshotHandle,
} from "./types.js";

// Stateful bridge between writeOpperConfig and spawn (same process; safe).
let pendingRouting: OpperRouting | null = null;

// Claude Code reads ANTHROPIC_BASE_URL and appends `/v1/messages`. Opper's
// Anthropic-shaped compat endpoint is rooted at `/v3/compat`, which gives us
// `/v3/compat/v1/messages` per the v3 OpenAPI spec.
const ANTHROPIC_COMPAT_BASE = "https://api.opper.ai/v3/compat";
const DEFAULT_SONNET_MODEL = "anthropic/claude-sonnet-4.6";
const DEFAULT_HAIKU_MODEL = "anthropic/claude-haiku-4.5";
const DEFAULT_OPUS_MODEL = "anthropic/claude-opus-4.7";

const INSTALL_HINT =
  "Install via `npm i -g @anthropic-ai/claude-code` or see https://docs.claude.com/en/docs/claude-code/setup";

async function detect(): Promise<DetectResult> {
  const path = await which("claude");
  if (!path) return { installed: false };
  return { installed: true };
}

async function install(): Promise<void> {
  throw new OpperError(
    "AGENT_NOT_FOUND",
    "Claude Code must be installed manually.",
    INSTALL_HINT,
  );
}

async function isConfigured(): Promise<boolean> {
  // Claude Code reads env vars at launch — no persistent config to inspect,
  // so "configured" collapses to "installed".
  return (await detect()).installed;
}

async function configure(): Promise<void> {
  if (!(await detect()).installed) {
    throw new OpperError(
      "AGENT_NOT_FOUND",
      "Claude Code is not installed",
      INSTALL_HINT,
    );
  }
  // No persistent config to write — `launch` injects env vars at spawn.
}

async function unconfigure(): Promise<void> {
  // No persistent Opper bits to remove.
}

async function snapshotConfig(): Promise<SnapshotHandle> {
  return {
    agent: "claude-code",
    backupPath: "",
    timestamp: new Date().toISOString(),
  };
}

async function writeOpperConfig(c: OpperRouting): Promise<void> {
  pendingRouting = c;
}

async function restoreConfig(_h: SnapshotHandle): Promise<void> {
  pendingRouting = null;
}

async function spawn(args: string[]): Promise<number> {
  const routing = pendingRouting;
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (routing) {
    env.ANTHROPIC_BASE_URL = ANTHROPIC_COMPAT_BASE;
    env.ANTHROPIC_AUTH_TOKEN = routing.apiKey;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = DEFAULT_SONNET_MODEL;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = DEFAULT_HAIKU_MODEL;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = DEFAULT_OPUS_MODEL;
  }
  const result = spawnSync("claude", args, { stdio: "inherit", env });
  return result.status ?? -1;
}

export const claudeCode: LaunchableAgentAdapter = {
  name: "claude-code",
  displayName: "Claude Code",
  binary: "claude",
  docsUrl: "https://docs.claude.com/en/docs/claude-code/setup",
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
