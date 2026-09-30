import { readFile, mkdir, writeFile, chmod, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import lockfile from "proper-lockfile";
import { OpperError } from "../errors.js";
import { configPath } from "./paths.js";

export interface AuthSlot {
  apiKey: string;
  /** Opaque server identifier for targeted renewal or revocation. */
  credentialId?: string;
  /** Organization that issued this personal credential. */
  orgId?: number;
  /** Project used for inference and budget attribution. */
  projectId?: number;
  projectUuid?: string;
  projectName?: string;
  /** Absolute server-issued expiry. Omitted for credentials without a lifetime. */
  expiresAt?: string;
  baseUrl?: string;
  user?: { email: string; name: string };
  obtainedAt?: string;
  source?: "device-flow" | "manual" | "migrated";
}

export function isSlotExpired(slot: AuthSlot, now = Date.now()): boolean {
  if (!slot.expiresAt) return false;
  const expiry = Date.parse(slot.expiresAt);
  // Invalid stored expiry metadata must not make a key appear valid forever.
  return !Number.isFinite(expiry) || expiry <= now;
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

/** Serialize credential writes across CLI processes without holding a lock during browser approval. */
export async function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(path, {
      // The config does not exist yet on first login. Refresh the lease while
      // writing; a crashed writer's lock becomes reclaimable after ten seconds.
      realpath: false,
      stale: 10_000,
      update: 2_000,
      retries: { retries: 500, factor: 1, minTimeout: 40, maxTimeout: 40 },
      // Keep the default fail-fast handling if our lock is compromised.
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
    throw new OpperError(
      "API_ERROR",
      "Credential config is busy; could not acquire its write lock.",
      "Another Opper process is writing credentials. Wait for it to finish and retry.",
    );
  }
  try {
    return await fn();
  } finally {
    await release();
  }
}

async function writeConfigUnlocked(config: Config): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export async function writeConfig(config: Config): Promise<void> {
  await withConfigLock(() => writeConfigUnlocked(config));
}

/** Used by legacy migration so another process's first login cannot be overwritten. */
export async function writeConfigIfAbsent(config: Config): Promise<boolean> {
  return withConfigLock(async () => {
    if (await readConfig()) return false;
    await writeConfigUnlocked(config);
    return true;
  });
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
  await withConfigLock(async () => {
    const cfg = (await readConfig()) ?? emptyConfig();
    const isFirstSlot = Object.keys(cfg.keys).length === 0;
    cfg.keys[name] = slot;
    if (isFirstSlot) cfg.defaultKey = name;
    await writeConfigUnlocked(cfg);
  });
}

/** Compare and replace inside one lock so a late browser result cannot overwrite a newer slot. */
export async function replaceSlotIfUnchanged(
  name: string,
  expected: AuthSlot | null,
  replacement: AuthSlot,
): Promise<boolean> {
  return withConfigLock(async () => {
    const cfg = (await readConfig()) ?? emptyConfig();
    const current = cfg.keys[name] ?? null;
    if (!isDeepStrictEqual(current, expected)) return false;
    const isFirstSlot = Object.keys(cfg.keys).length === 0;
    cfg.keys[name] = replacement;
    if (isFirstSlot) cfg.defaultKey = name;
    await writeConfigUnlocked(cfg);
    return true;
  });
}

export async function deleteSlot(name: string): Promise<void> {
  await withConfigLock(async () => {
    const cfg = await readConfig();
    if (!cfg || !(name in cfg.keys)) return;
    delete cfg.keys[name];
    if (cfg.defaultKey === name) {
      const remaining = Object.keys(cfg.keys);
      cfg.defaultKey = remaining[0] ?? "default";
    }
    await writeConfigUnlocked(cfg);
  });
}

export async function clearAllSlots(): Promise<void> {
  await withConfigLock(async () => {
    const cfg = await readConfig();
    if (!cfg || Object.keys(cfg.keys).length === 0) return;
    await writeConfigUnlocked({ ...cfg, keys: {}, defaultKey: "default" });
  });
}
