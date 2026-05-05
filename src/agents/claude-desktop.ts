import { OpperError } from "../errors.js";
import type {
  AgentAdapter,
  ConfigureOptions,
  DetectResult,
  OpperRouting,
} from "./types.js";

async function detect(): Promise<DetectResult> {
  return { installed: false };
}

async function isConfigured(): Promise<boolean> {
  return false;
}

async function configure(_opts: ConfigureOptions): Promise<void> {
  throw new OpperError("AGENT_NOT_FOUND", "claude-desktop adapter not yet implemented");
}

async function unconfigure(): Promise<void> {
  // Filled in by Task 6.
}

async function install(): Promise<void> {
  throw new OpperError(
    "AGENT_NOT_FOUND",
    "Claude Desktop must be installed manually.",
    "Download Claude Desktop from https://claude.ai/download.",
  );
}

async function spawn(_args: string[], _routing: OpperRouting): Promise<number> {
  throw new OpperError("AGENT_NOT_FOUND", "claude-desktop adapter not yet implemented");
}

export const claudeDesktop: AgentAdapter = {
  name: "claude-desktop",
  displayName: "Claude Desktop",
  docsUrl: "https://claude.ai/download",
  detect,
  isConfigured,
  configure,
  unconfigure,
  install,
  spawn,
};
