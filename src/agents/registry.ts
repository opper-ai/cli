import type { AgentAdapter } from "./types.js";
import { hermes } from "./hermes.js";

const ADAPTERS: ReadonlyArray<AgentAdapter> = [hermes];

export function listAdapters(): ReadonlyArray<AgentAdapter> {
  return ADAPTERS;
}

export function getAdapter(name: string): AgentAdapter | null {
  return ADAPTERS.find((a) => a.name === name) ?? null;
}
