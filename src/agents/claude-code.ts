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
  // Claude Code's /model picker shows two stacked sets of entries:
  //   1. Anthropic's built-in tiers (Default, Sonnet, Haiku, Opus, …) which
  //      send Anthropic-style model IDs that Opper's compat endpoint won't
  //      recognise.
  //   2. Whatever ANTHROPIC_DEFAULT_*_MODEL we set, each appearing as an
  //      additional pinned row that *does* send an Opper-format ID.
  // We can't suppress (1) via env vars, but we can label (2) with custom
  // `*_NAME` strings so users can tell which entries route through Opper.
  // ANTHROPIC_MODEL pins the initial active selection.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: OPPER_COMPAT_URL,
    ANTHROPIC_AUTH_TOKEN: routing.apiKey,
    ANTHROPIC_MODEL: routing.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: DEFAULT_MODELS.opus,
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "Opus 4.7 (via Opper)",
    ANTHROPIC_DEFAULT_SONNET_MODEL: DEFAULT_MODELS.sonnet,
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "Sonnet 4.6 (via Opper)",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: DEFAULT_MODELS.haiku,
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: "Haiku 4.5 (via Opper)",
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
