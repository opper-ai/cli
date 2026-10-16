import { spawnSync } from "../util/spawn.js";
import { which } from "../util/which.js";
import { OpperError } from "../errors.js";
import { npmInstallGlobal } from "./npm-install.js";
import { OpperApi } from "../api/client.js";
import { brand } from "../ui/colors.js";
import type { CompatModel } from "../setup/opencode-models.js";
import type {
  AgentAdapter,
  DetectResult,
  OpperRouting,
} from "./types.js";

// Claude Code reads ANTHROPIC_BASE_URL and appends `/v1/messages` for
// inference and `/v1/models` for the /model picker. Opper's compat
// and session endpoints serve both. Gateway model discovery must be
// explicitly enabled for Claude Code to populate the picker.

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

/**
 * Claude Code assumes a 200k window for any model it doesn't know, and only
 * reads CLAUDE_CODE_MAX_CONTEXT_TOKENS for those models. There is one value
 * per process, so it is taken from the launched model: a later `/model`
 * switch to another non-Claude model keeps it. Claude models are skipped
 * (Claude Code knows their windows), as is a value the user set themselves.
 * A failed catalog lookup leaves Claude Code's 200k default in place.
 */
export async function contextWindowEnv(routing: OpperRouting): Promise<Record<string, string>> {
  if (process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS || /claude/i.test(routing.model)) return {};
  try {
    const api = new OpperApi({ baseUrl: routing.apiBaseUrl, apiKey: routing.apiKey, projectUuid: routing.projectUuid });
    const res = await api.get<{ data?: CompatModel[] }>("/v3/compat/models");
    const context = res.data?.find((m) => m.id === routing.model)?.context_length;
    if (!Number.isSafeInteger(context) || !context || context <= 0) return {};
    return { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(context) };
  } catch {
    return {};
  }
}

async function spawn(args: string[], routing: OpperRouting): Promise<number> {
  // ANTHROPIC_MODEL pins the initial active selection; opt in to fetching
  // the picker models from the same authenticated Opper session endpoint.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: routing.baseUrl,
    ANTHROPIC_AUTH_TOKEN: routing.apiKey,
    ANTHROPIC_MODEL: routing.model,
    // Replace a stale target inherited from another invocation. Preserve
    // unrelated user headers while making this launch's selection authoritative.
    ANTHROPIC_CUSTOM_HEADERS: [
      ...(process.env.ANTHROPIC_CUSTOM_HEADERS ?? "").split(/\r?\n/).filter((line) => line.trim() && !/^\s*x-opper-project\s*:/i.test(line)),
      ...(routing.projectUuid ? [`X-Opper-Project: ${routing.projectUuid}`] : []),
    ].join("\n"),
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    // Suppress telemetry/auto-update/error-report calls that Claude Code
    // would otherwise send to api.anthropic.com directly. Users routing
    // through Opper typically have no Anthropic key, so those calls fail
    // noisily and can leak the gateway token outside Opper.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // Claude Code turns tool search off for any non-Anthropic base URL, so
    // every MCP tool definition is sent on every turn. Opper forwards
    // tool_reference to Claude and emulates it for other models, so keep
    // deferred loading on unless the user chose a setting themselves.
    ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH || "true",
  };
  const contextEnv = await contextWindowEnv(routing);
  Object.assign(env, contextEnv);
  if (contextEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS) {
    // The window holds for every non-Claude model this session switches to
    // with /model, so point at the switch that keeps it correct.
    console.log(brand.dim(
      `Context window: ${Number(contextEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toLocaleString("en-US")} tokens for ${routing.model}. ` +
      `To switch to another non-Claude model and keep this conversation: opper launch claude --model <id> -- --continue`,
    ));
  }
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
