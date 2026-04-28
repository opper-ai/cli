import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { configureContinue } from "../setup/continue.js";
import { continueConfigPath } from "../util/editor-paths.js";
import { OPPER_COMPAT_URL } from "../config/endpoints.js";
import { OpperError } from "../errors.js";
import type {
  AgentAdapter,
  ConfigureOptions,
  DetectResult,
} from "./types.js";

async function detect(): Promise<DetectResult> {
  // Continue.dev is a VS Code extension; we can't reliably detect the
  // extension itself. We treat "detected" as "config file present" — i.e.
  // the user has at least opened Continue once and it's installed.
  const cfg = continueConfigPath("global");
  if (!existsSync(cfg)) return { installed: false };
  return { installed: true, configPath: cfg };
}

async function isConfigured(): Promise<boolean> {
  const cfg = continueConfigPath("global");
  if (!existsSync(cfg)) return false;
  try {
    const parsed = parse(readFileSync(cfg, "utf8")) as {
      models?: Array<{ apiBase?: unknown }>;
    } | null;
    if (!parsed?.models?.length) return false;
    return parsed.models.some(
      (m) => (m as { apiBase?: unknown }).apiBase === OPPER_COMPAT_URL,
    );
  } catch {
    return false;
  }
}

async function configure(opts: ConfigureOptions): Promise<void> {
  if (!opts.apiKey) {
    throw new OpperError(
      "AUTH_REQUIRED",
      "Continue.dev configuration needs an Opper API key.",
      "Run `opper login` first, or set OPPER_API_KEY.",
    );
  }
  await configureContinue({
    location: "global",
    apiKey: opts.apiKey,
    overwrite: true,
  });
}

async function unconfigure(): Promise<void> {
  const cfg = continueConfigPath("global");
  if (!existsSync(cfg)) return;
  let parsed: { models?: Array<Record<string, unknown>>; [k: string]: unknown } | null;
  try {
    parsed = parse(readFileSync(cfg, "utf8")) as typeof parsed;
  } catch {
    return;
  }
  if (!parsed || !Array.isArray(parsed.models)) return;
  const filtered = parsed.models.filter(
    (m) => (m as { apiBase?: unknown }).apiBase !== OPPER_COMPAT_URL,
  );
  if (filtered.length === parsed.models.length) return;
  parsed.models = filtered;
  await writeFile(cfg, stringify(parsed), "utf8");
}

export const continueDev: AgentAdapter = {
  name: "continue",
  displayName: "Continue.dev",
  docsUrl: "https://continue.dev",
  detect,
  isConfigured,
  configure,
  unconfigure,
};
