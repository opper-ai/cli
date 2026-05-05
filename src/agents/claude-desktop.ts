import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { OpperError } from "../errors.js";
import type {
  AgentAdapter,
  ConfigureOptions,
  DetectResult,
  OpperRouting,
} from "./types.js";

function darwinAppCandidates(): string[] {
  return [
    "/Applications/Claude.app",
    join(homedir(), "Applications", "Claude.app"),
  ];
}

function windowsLocalAppData(): string | null {
  const local = (process.env.LOCALAPPDATA ?? "").trim();
  if (local) return local;
  const profile = (process.env.USERPROFILE ?? "").trim();
  if (profile) return join(profile, "AppData", "Local");
  try {
    return join(homedir(), "AppData", "Local");
  } catch {
    return null;
  }
}

function windowsAppCandidates(): string[] {
  const local = windowsLocalAppData();
  if (!local) return [];
  return [
    join(local, "Programs", "Claude", "Claude.exe"),
    join(local, "Programs", "Claude Desktop", "Claude.exe"),
    join(local, "Claude", "Claude.exe"),
    join(local, "Claude Nest", "Claude.exe"),
    join(local, "Claude Desktop", "Claude.exe"),
    join(local, "AnthropicClaude", "Claude.exe"),
  ];
}

function appCandidates(): string[] {
  switch (platform()) {
    case "darwin":
      return darwinAppCandidates();
    case "win32":
      return windowsAppCandidates();
    default:
      return [];
  }
}

async function detect(): Promise<DetectResult> {
  for (const candidate of appCandidates()) {
    if (existsSync(candidate)) return { installed: true };
  }
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
