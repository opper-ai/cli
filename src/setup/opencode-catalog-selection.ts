import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { OpperError } from "../errors.js";
import { parseJsoncObject } from "../util/jsonc.js";
import { opencodeConfigPath } from "../util/editor-paths.js";
import { validateModelKinds, type CatalogSelection, type ModelKinds } from "./model-catalog.js";

/** Existing catalogs can back selections in session history we cannot enumerate. */
export function openCodePreservedIds(value: unknown): string[] {
  const ids = new Set<string>();
  function visit(item: unknown): void {
    if (typeof item === "string" && item.startsWith("opper/")) ids.add(item.slice(6));
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object") {
      const ref = item as { providerID?: unknown; modelID?: unknown };
      if (ref.providerID === "opper" && typeof ref.modelID === "string") ids.add(ref.modelID);
      Object.values(item).forEach(visit);
    }
  }
  visit(value);
  const provider = (value as { provider?: { opper?: {models?: unknown; whitelist?: unknown} } } | undefined)?.provider?.opper;
  if (provider?.models && typeof provider.models === "object" && !Array.isArray(provider.models)) Object.keys(provider.models).forEach(id => ids.add(id));
  if (Array.isArray(provider?.whitelist)) provider.whitelist.forEach(id => { if (typeof id === "string") ids.add(id); });
  return [...ids];
}

export function openCodeCatalogSelection(modelKinds?: ModelKinds, selectedModel?: string, paths?: string[]): CatalogSelection {
  if (modelKinds !== undefined) validateModelKinds(modelKinds);
  const sources: unknown[] = [];
  const home = process.env.OPPER_EDITOR_HOME ?? homedir();
  const files = new Set(paths ?? [opencodeConfigPath("global"), opencodeConfigPath("global").replace(/\.json$/, ".jsonc")]);
  if (!paths) {
    files.add(join(process.env.XDG_STATE_HOME ?? join(home, ".local", "state"), "opencode", "model.json"));
    if (process.env.OPENCODE_CONFIG) files.add(resolve(process.env.OPENCODE_CONFIG));
    if (process.env.OPENCODE_CONFIG_DIR) for (const name of ["opencode.json", "opencode.jsonc"]) files.add(join(process.env.OPENCODE_CONFIG_DIR, name));
    for (let dir = process.cwd(); ; dir = dirname(dir)) {
      for (const name of ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"]) files.add(join(dir, name));
      if (dirname(dir) === dir) break;
    }
    if (process.env.OPENCODE_CONFIG_CONTENT) {
      try { sources.push(parseJsoncObject(process.env.OPENCODE_CONFIG_CONTENT)); }
      catch { throw new OpperError("AGENT_CONFIG_CONFLICT", "Cannot parse OPENCODE_CONFIG_CONTENT. Existing configuration was preserved."); }
    }
  }
  // Do not narrow on an unreadable/malformed source and then overwrite it.
  // The existing writer/runtime validation reports the original config error.
  let opaque = false;
  for (const path of files) {
    if (!existsSync(path)) continue;
    try { sources.push(parseJsoncObject(readFileSync(path, "utf8"))); } catch { opaque = true; }
  }
  return {
    modelKinds: opaque ? "all" : modelKinds ?? "pools,routes",
    ...(selectedModel ? { selectedModel: selectedModel.startsWith("opper/") ? selectedModel.slice(6) : selectedModel } : {}),
    preserveIds: [...new Set(sources.flatMap(openCodePreservedIds))],
  };
}
