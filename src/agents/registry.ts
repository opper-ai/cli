import type { AgentAdapter } from "./types.js";
import { opencode } from "./opencode.js";
import { claudeCode } from "./claude-code.js";
import { hermes } from "./hermes.js";
import { continueDev } from "./continue.js";

const ADAPTERS: ReadonlyArray<AgentAdapter> = [
  opencode,
  claudeCode,
  hermes,
  continueDev,
];

export function listAdapters(): ReadonlyArray<AgentAdapter> {
  return ADAPTERS;
}

export function getAdapter(name: string): AgentAdapter | null {
  return ADAPTERS.find((a) => a.name === name) ?? null;
}
