import { spawnSync } from "node:child_process";
import { which } from "../util/which.js";
import { OpperError } from "../errors.js";
import type {
  AgentAdapter,
  DetectResult,
  OpperRouting,
} from "./types.js";

import { OPPER_COMPAT_URL } from "../config/endpoints.js";
import { DEFAULT_MODELS } from "../config/models.js";

// Claude Code reads ANTHROPIC_BASE_URL and appends `/v1/messages`. Opper's
// compat endpoint at `/v3/compat` accepts the Anthropic Messages shape, so
// the resolved URL becomes `/v3/compat/v1/messages`.

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
    ANTHROPIC_BASE_URL: OPPER_COMPAT_URL,
    ANTHROPIC_AUTH_TOKEN: routing.apiKey,
    ANTHROPIC_DEFAULT_SONNET_MODEL: DEFAULT_MODELS.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: DEFAULT_MODELS.haiku,
    ANTHROPIC_DEFAULT_OPUS_MODEL: DEFAULT_MODELS.opus,
  };
  const result = spawnSync("claude", args, { stdio: "inherit", env });
  return result.status ?? -1;
}

export const claudeCode: AgentAdapter = {
  name: "claude",
  displayName: "Claude Code",
  docsUrl: "https://docs.claude.com/en/docs/claude-code/setup",
  detect,
  isConfigured,
  configure,
  unconfigure,
  install,
  spawn,
};
