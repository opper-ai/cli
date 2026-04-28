import type { AgentAdapter } from "./types.js";
import { opencode } from "./opencode.js";
import { claudeCode } from "./claude-code.js";
import { codex } from "./codex.js";
import { hermes } from "./hermes.js";
import { pi } from "./pi.js";
import { continueDev } from "./continue.js";

const ADAPTERS: ReadonlyArray<AgentAdapter> = [
  opencode,
  claudeCode,
  codex,
  hermes,
  pi,
  continueDev,
];

export function listAdapters(): ReadonlyArray<AgentAdapter> {
  return ADAPTERS;
}

export function getAdapter(name: string): AgentAdapter | null {
  return ADAPTERS.find((a) => a.name === name) ?? null;
}
