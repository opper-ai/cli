import { isDeepStrictEqual } from "node:util";
import { getStaticTOMLValue, parseTOML, type AST } from "toml-eslint-parser";
import { OpperError } from "../errors.js";

export const DESKTOP_PROVIDER = "opper-desktop";
const ROOT_KEYS = ["model", "model_provider", "model_catalog_json", "web_search"] as const;
type RootKey = (typeof ROOT_KEYS)[number];
export interface DesktopSettings {
  model: string;
  model_catalog_json: string;
  provider: Record<string, unknown>;
}
export interface DesktopConfigState {
  version: 1;
  originalText: string;
  appliedText: string;
  settings: DesktopSettings;
  originalValues: Partial<Record<RootKey, string>>;
}

function document(text: string): AST.TOMLProgram {
  try { return parseTOML(text, { tomlVersion: "1.0" }); }
  catch { throw new OpperError("AGENT_CONFIG_CONFLICT", "Codex config.toml is not valid TOML. Fix it before configuring Opper."); }
}

export function readDesktopConfig(text: string): Record<string, unknown> {
  return getStaticTOMLValue(document(text)) as Record<string, unknown>;
}

function providerOf(text: string): unknown {
  const providers = readDesktopConfig(text).model_providers;
  return providers && typeof providers === "object"
    ? (providers as Record<string, unknown>)[DESKTOP_PROVIDER] : undefined;
}

function rootNode(ast: AST.TOMLProgram, key: RootKey): AST.TOMLKeyValue | undefined {
  return ast.body[0].body.find((n): n is AST.TOMLKeyValue =>
    n.type === "TOMLKeyValue" && isDeepStrictEqual(getStaticTOMLValue(n.key), [key]));
}

// Only value ranges change. Comments, formatting, multiline strings and unrelated
// settings remain byte-for-byte intact; TOML's AST supplies the real boundaries.
function patchRoot(text: string, values: Partial<Record<RootKey, string | null>>): string {
  const ast = document(text);
  const edits: { start: number; end: number; text: string }[] = [];
  const additions: string[] = [];
  for (const key of ROOT_KEYS) {
    const value = values[key];
    if (value === undefined) continue;
    const node = rootNode(ast, key);
    if (node) {
      const range = value === null ? node.range : node.value.range;
      edits.push({ start: range[0], end: range[1], text: value ?? "" });
    } else if (value !== null) additions.push(`${key} = ${value}\n`);
  }
  for (const e of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  return additions.join("") + text;
}

function toml(value: unknown): string {
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`).join(", ")} }`;
  }
  throw new Error("Invalid generated Codex provider setting");
}

function stripProvider(text: string): string {
  const tables = document(text).body[0].body.filter((n): n is AST.TOMLTable =>
    n.type === "TOMLTable" && n.resolvedKey[0] === "model_providers" && n.resolvedKey[1] === DESKTOP_PROVIDER);
  for (const t of tables.sort((a, b) => b.range[0] - a.range[0])) {
    text = text.slice(0, t.range[0]) + text.slice(t.range[1]);
  }
  // An independently rewritten inline/dotted provider is not safe to strip.
  if (providerOf(text) !== undefined) throw new OpperError("AGENT_CONFIG_CONFLICT", "The Opper desktop provider layout changed. Restore its original table before removing the integration.");
  return text;
}

export function applyDesktopConfig(text: string, settings: DesktopSettings, previous?: DesktopConfigState): { text: string; state: DesktopConfigState } {
  if (previous) text = removeDesktopConfig(text, previous);
  if (providerOf(text) !== undefined) throw new OpperError("AGENT_CONFIG_CONFLICT", "A provider named opper-desktop already exists and is not managed by this integration.");
  const originalText = text;
  const ast = document(text);
  const originalValues: Partial<Record<RootKey, string>> = {};
  for (const key of ROOT_KEYS) {
    const node = rootNode(ast, key);
    if (node) originalValues[key] = text.slice(...node.value.range);
  }
  text = patchRoot(text, {
    model: toml(settings.model), model_provider: toml(DESKTOP_PROVIDER), model_catalog_json: toml(settings.model_catalog_json),
    // Codex defaults to OpenAI's cached-only web search. Opper cannot honor
    // that service's semantics across providers; do not turn it into live search.
    web_search: toml("disabled"),
  });
  text += `${text.endsWith("\n") ? "" : "\n"}\n[model_providers.${DESKTOP_PROVIDER}]\n${Object.entries(settings.provider).map(([k, v]) => `${k} = ${toml(v)}\n`).join("")}`;
  document(text);
  return { text, state: { version: 1, originalText, appliedText: text, settings, originalValues } };
}

export function removeDesktopConfig(text: string, state: DesktopConfigState): string {
  if (state.version !== 1) throw new OpperError("AGENT_CONFIG_CONFLICT", "Unrecognized Opper desktop configuration backup.");
  if (text === state.appliedText) return state.originalText;
  const provider = providerOf(text);
  if (provider !== undefined && !isDeepStrictEqual(provider, state.settings.provider)) {
    throw new OpperError("AGENT_CONFIG_CONFLICT", "The Opper desktop provider changed since setup. Restore its generated settings before removing it.");
  }
  const current = readDesktopConfig(text);
  const expected = { model: state.settings.model, model_provider: DESKTOP_PROVIDER, model_catalog_json: state.settings.model_catalog_json, web_search: "disabled" };
  const values: Partial<Record<RootKey, string | null>> = {};
  for (const key of ROOT_KEYS) if (current[key] === expected[key]) values[key] = state.originalValues[key] ?? null;
  const result = patchRoot(provider === undefined ? text : stripProvider(text), values);
  document(result);
  return result;
}
