import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { writeConfig, type Config } from "./config.js";
import { configPath } from "./paths.js";
import { existsSync } from "node:fs";

interface LegacyFile {
  api_keys?: Record<
    string,
    { key?: string; baseUrl?: string }
  >;
}

export async function maybeMigrateLegacyConfig(legacyPath: string): Promise<boolean> {
  if (!existsSync(legacyPath)) return false;
  if (existsSync(configPath())) return false;

  let raw: string;
  try {
    raw = await readFile(legacyPath, "utf8");
  } catch {
    return false;
  }

  const parsed = parseYaml(raw) as LegacyFile | null;
  const keys = parsed?.api_keys;
  if (!keys || typeof keys !== "object") return false;

  const slots: Config["keys"] = {};
  for (const [name, entry] of Object.entries(keys)) {
    if (!entry?.key) continue;
    slots[name] = {
      apiKey: entry.key,
      ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      source: "migrated",
    };
  }
  if (Object.keys(slots).length === 0) return false;

  const firstKey = Object.keys(slots)[0]!;
  const defaultKey = "default" in slots ? "default" : firstKey;

  await writeConfig({ version: 1, defaultKey, keys: slots });
  return true;
}
