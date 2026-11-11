import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { writeConfigIfAbsent, type Config } from "./config.js";
import { configPath, legacyMigrationSentinelPath } from "./paths.js";

interface LegacyFile {
  api_keys?: Record<
    string,
    { key?: string; baseUrl?: string }
  >;
}

/** Read the same eligible legacy profile as migration, without writing config or a sentinel. */
export async function previewLegacyConfig(legacyPath: string): Promise<Config | null> {
  if (existsSync(legacyMigrationSentinelPath()) || !existsSync(legacyPath) || existsSync(configPath())) return null;

  let raw: string;
  try {
    raw = await readFile(legacyPath, "utf8");
  } catch {
    return null;
  }

  const parsed = parseYaml(raw) as LegacyFile | null;
  const keys = parsed?.api_keys;
  if (!keys || typeof keys !== "object") {
    return null;
  }

  const slots: Config["keys"] = {};
  for (const [name, entry] of Object.entries(keys)) {
    if (!entry?.key) continue;
    slots[name] = {
      apiKey: entry.key,
      ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      source: "migrated",
    };
  }
  if (Object.keys(slots).length === 0) {
    return null;
  }

  const firstKey = Object.keys(slots)[0]!;
  const defaultKey = "default" in slots ? "default" : firstKey;

  return { version: 1, defaultKey, keys: slots };
}

export async function maybeMigrateLegacyConfig(legacyPath: string): Promise<boolean> {
  const sentinel = legacyMigrationSentinelPath();
  if (existsSync(sentinel)) return false;
  const config = await previewLegacyConfig(legacyPath);
  const wrote = config ? await writeConfigIfAbsent(config) : false;
  await stampSentinel(sentinel);
  return wrote;
}

async function stampSentinel(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, new Date().toISOString() + "\n", { mode: 0o600 });
}
