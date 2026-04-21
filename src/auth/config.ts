import { readFile } from "node:fs/promises";
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
