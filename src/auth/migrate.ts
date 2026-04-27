import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { writeConfig, type Config } from "./config.js";
import { configPath, legacyMigrationSentinelPath } from "./paths.js";

interface LegacyFile {
  api_keys?: Record<
    string,
    { key?: string; baseUrl?: string }
  >;
}

export async function maybeMigrateLegacyConfig(legacyPath: string): Promise<boolean> {
  const sentinel = legacyMigrationSentinelPath();
  if (existsSync(sentinel)) return false;
  if (!existsSync(legacyPath)) {
    await stampSentinel(sentinel);
    return false;
  }
  if (existsSync(configPath())) {
    await stampSentinel(sentinel);
    return false;
  }

  let raw: string;
  try {
    raw = await readFile(legacyPath, "utf8");
  } catch {
    await stampSentinel(sentinel);
    return false;
  }

  const parsed = parseYaml(raw) as LegacyFile | null;
  const keys = parsed?.api_keys;
  if (!keys || typeof keys !== "object") {
    await stampSentinel(sentinel);
    return false;
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
    await stampSentinel(sentinel);
    return false;
  }

  const firstKey = Object.keys(slots)[0]!;
  const defaultKey = "default" in slots ? "default" : firstKey;

  await writeConfig({ version: 1, defaultKey, keys: slots });
  await stampSentinel(sentinel);
  return true;
}

async function stampSentinel(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, new Date().toISOString() + "\n", { mode: 0o600 });
}
