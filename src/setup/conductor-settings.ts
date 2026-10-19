import { isDeepStrictEqual } from "node:util";
import { isAbsolute } from "node:path";
import { getStaticTOMLValue, parseTOML, type AST } from "toml-eslint-parser";
import { OpperError } from "../errors.js";

const KEYS = ["codex_provider", "codex_executable_path"] as const;
type Key = typeof KEYS[number];
export interface ConductorSettingsBackup {
  version: 1;
  existed: boolean;
  wrapper: string;
  /** Only the two previous TOML literals, never the surrounding settings. */
  values: Record<Key, string | null>;
}
const conflict = (message: string) => new OpperError("AGENT_CONFIG_CONFLICT", message);
function document(text: string): AST.TOMLProgram {
  try { return parseTOML(text, {tomlVersion: "1.0"}); } catch { throw conflict("Conductor settings.toml is not valid TOML; it was preserved."); }
}
function values(text: string): Record<string, unknown> {
  const value = getStaticTOMLValue(document(text)) as Record<string, unknown>;
  for (const key of KEYS) if (value[key] !== undefined && typeof value[key] !== "string") throw conflict(`Conductor ${key} must be a string; settings were preserved.`);
  return value;
}
function rootNode(ast: AST.TOMLProgram, key: Key): AST.TOMLKeyValue | undefined {
  return ast.body[0].body.find((node): node is AST.TOMLKeyValue => node.type === "TOMLKeyValue" && isDeepStrictEqual(getStaticTOMLValue(node.key), [key]));
}
function patch(text: string, replacements: Record<Key, string | null>): string {
  const ast = document(text), edits: {start: number; end: number; value: string}[] = [], additions: string[] = [];
  for (const key of KEYS) {
    const node = rootNode(ast, key), replacement = replacements[key];
    if (!node) { if (replacement !== null) additions.push(`${key} = ${replacement}\n`); continue; }
    if (replacement !== null) edits.push({start: node.value.range[0], end: node.value.range[1], value: replacement});
    else {
      let end = node.range[1];
      if (text.slice(end, end + 2) === "\r\n") end += 2;
      else if (text[end] === "\n") end++;
      edits.push({start: node.range[0], end, value: ""});
    }
  }
  for (const edit of edits.sort((a,b)=>b.start-a.start)) text = text.slice(0,edit.start)+edit.value+text.slice(edit.end);
  return additions.join("")+text;
}
export function parseConductorSettingsBackup(text: string): ConductorSettingsBackup {
  try {
    const backup = JSON.parse(text) as ConductorSettingsBackup;
    if (backup?.version !== 1 || typeof backup.existed !== "boolean" || typeof backup.wrapper !== "string" || !isAbsolute(backup.wrapper) ||
        !isDeepStrictEqual(Object.keys(backup).sort(), ["existed","values","version","wrapper"]) ||
        !backup.values || !isDeepStrictEqual(Object.keys(backup.values).sort(), [...KEYS].sort())) throw new Error();
    for (const key of KEYS) {
      const raw = backup.values[key];
      if (raw === null) continue;
      if (typeof raw !== "string") throw new Error();
      const parsed = values(`${key} = ${raw}`);
      if (!isDeepStrictEqual(Object.keys(parsed), [key]) || typeof parsed[key] !== "string") throw new Error();
    }
    return backup;
  } catch { throw conflict("Invalid Conductor settings backup; settings and integration files were preserved."); }
}
function managed(current: Record<string, unknown>, wrapper: string): boolean {
  return current.codex_provider === "default" && current.codex_executable_path === wrapper;
}
export function configureConductorSettings(text: string | null, wrapper: string, previous?: ConductorSettingsBackup): {text: string; backup: ConductorSettingsBackup} {
  const current = values(text ?? "");
  if (previous && (previous.wrapper !== wrapper || !managed(current, wrapper))) throw conflict("Conductor's selected Codex executable or provider changed after setup; settings were preserved.");
  const ast = document(text ?? ""), original = Object.fromEntries(KEYS.map(key => {
    const node = rootNode(ast,key);
    return [key,node ? (text ?? "").slice(...node.value.range) : null];
  })) as Record<Key,string|null>;
  // An older manual setup has no original path to restore. Removing our
  // integration must return to Conductor's bundled executable, not a dead path.
  if (!previous && current.codex_executable_path === wrapper) original.codex_executable_path = null;
  const backup = previous ?? {version: 1, existed: text !== null, wrapper, values: original};
  return {text: patch(text ?? "", {codex_provider: JSON.stringify("default"), codex_executable_path: JSON.stringify(wrapper)}), backup};
}
export function restoreConductorSettings(text: string | null, backup: ConductorSettingsBackup): string | null {
  if (text === null) return null;
  const current = values(text);
  if (!managed(current, backup.wrapper)) {
    if (current.codex_executable_path === backup.wrapper) throw conflict("Conductor's provider changed after setup while its executable still uses Opper; settings were preserved.");
    return text;
  }
  const restored = patch(text, backup.values);
  return !backup.existed && !restored.trim() ? null : restored;
}
