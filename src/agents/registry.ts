import type { AgentAdapter } from "./types.js";
import { opencode } from "./opencode.js";
import { claudeCode } from "./claude-code.js";
import { claudeDesktop } from "./claude-desktop.js";
import { codex } from "./codex.js";
import { hermes } from "./hermes.js";
import { pi } from "./pi.js";
import { openclaw } from "./openclaw.js";

const ADAPTERS: ReadonlyArray<AgentAdapter> = [
  opencode,
  claudeCode,
  claudeDesktop,
  codex,
  hermes,
  pi,
  openclaw,
];

export function listAdapters(): ReadonlyArray<AgentAdapter> {
  return ADAPTERS;
}

export function getAdapter(name: string): AgentAdapter | null {
  return ADAPTERS.find((a) => a.name === name) ?? null;
}
