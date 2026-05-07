import { spawnSync } from "node:child_process";
import { which } from "../util/which.js";
import { OpperError } from "../errors.js";
import { npmInstallGlobal } from "./npm-install.js";
import type {
  AgentAdapter,
  DetectResult,
  OpperRouting,
} from "./types.js";

import { OPPER_COMPAT_URL } from "../config/endpoints.js";

// Claude Code reads ANTHROPIC_BASE_URL and appends `/v1/messages` for
// inference and `/v1/models` for the /model picker. Opper's compat
// endpoint at `/v3/compat` serves both, so the picker auto-populates
// with Opper's catalogue.

const DOCS_URL = "https://docs.claude.com/en/docs/claude-code/setup";
const INSTALL_HINT = `Install via \`npm i -g @anthropic-ai/claude-code\` or see ${DOCS_URL}`;

async function detect(): Promise<DetectResult> {
  const path = await which("claude");
  if (!path) return { installed: false };
  return { installed: true };
}

async function install(): Promise<void> {
  await npmInstallGlobal("@anthropic-ai/claude-code", DOCS_URL);
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
  // ANTHROPIC_MODEL pins the initial active selection; the picker pulls
  // the rest from `${ANTHROPIC_BASE_URL}/v1/models`.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: OPPER_COMPAT_URL,
    ANTHROPIC_AUTH_TOKEN: routing.apiKey,
    ANTHROPIC_MODEL: routing.model,
    // Suppress telemetry/auto-update/error-report calls that Claude Code
    // would otherwise send to api.anthropic.com directly. Users routing
    // through Opper typically have no Anthropic key, so those calls fail
    // noisily and can leak the gateway token outside Opper.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
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
