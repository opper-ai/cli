import { readFile, mkdir, writeFile, chmod, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { OpperError } from "../errors.js";
import { configPath } from "./paths.js";

export interface AuthSlot {
  apiKey: string;
  baseUrl?: string;
  user?: { email: string; name: string };
  obtainedAt?: string;
  source?: "device-flow" | "manual" | "migrated";
}

export interface Config {
  version: 1;
  defaultKey: string;
  keys: Record<string, AuthSlot>;
  telemetry?: {
    enabled: boolean;
    anonId?: string;
  };
}

export async function readConfig(): Promise<Config | null> {
  let raw: string;
  try {
    raw = await readFile(configPath(), "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as Config;
  } catch (err) {
    throw new OpperError(
      "API_ERROR",
      `Malformed config file at ${configPath()}`,
      "Delete the file or fix the JSON manually.",
    );
  }
}

export async function writeConfig(config: Config): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

function emptyConfig(): Config {
  return { version: 1, defaultKey: "default", keys: {} };
}

export async function getSlot(name?: string): Promise<AuthSlot | null> {
  const cfg = await readConfig();
  if (!cfg) return null;
  const key = name ?? cfg.defaultKey;
  return cfg.keys[key] ?? null;
}

export async function setSlot(name: string, slot: AuthSlot): Promise<void> {
  const cfg = (await readConfig()) ?? emptyConfig();
  const isFirstSlot = Object.keys(cfg.keys).length === 0;
  cfg.keys[name] = slot;
  if (isFirstSlot) cfg.defaultKey = name;
  await writeConfig(cfg);
}

export async function deleteSlot(name: string): Promise<void> {
  const cfg = await readConfig();
  if (!cfg || !(name in cfg.keys)) return;
  delete cfg.keys[name];
  if (cfg.defaultKey === name) {
    const remaining = Object.keys(cfg.keys);
    cfg.defaultKey = remaining[0] ?? "default";
  }
  await writeConfig(cfg);
}
