import { spawnSync } from "node:child_process";
import { which } from "../util/which.js";
import { OpperError } from "../errors.js";
import type {
  AgentAdapter,
  DetectResult,
  OpperRouting,
} from "./types.js";

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
}

async function unconfigure(): Promise<void> {
  // No persistent Opper bits to remove.
}

async function spawn(args: string[], routing: OpperRouting): Promise<number> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: ANTHROPIC_COMPAT_BASE,
    ANTHROPIC_AUTH_TOKEN: routing.apiKey,
    ANTHROPIC_DEFAULT_SONNET_MODEL: DEFAULT_SONNET_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: DEFAULT_HAIKU_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: DEFAULT_OPUS_MODEL,
  };
  const result = spawnSync("claude", args, { stdio: "inherit", env });
  return result.status ?? -1;
}

export const claudeCode: AgentAdapter = {
  name: "claude-code",
  displayName: "Claude Code",
  docsUrl: "https://docs.claude.com/en/docs/claude-code/setup",
  detect,
  isConfigured,
  configure,
  unconfigure,
  install,
  spawn,
};
