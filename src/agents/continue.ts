import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { configureContinue } from "../setup/continue.js";
import { continueConfigPath } from "../util/editor-paths.js";
import { OPPER_OPENAI_COMPAT_URL } from "../api/compat.js";
import { OpperError } from "../errors.js";
import type {
  ConfigOnlyAgentAdapter,
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
      (m) => (m as { apiBase?: unknown }).apiBase === OPPER_OPENAI_COMPAT_URL,
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

export const continueDev: ConfigOnlyAgentAdapter = {
  name: "continue",
  displayName: "Continue.dev",
  docsUrl: "https://continue.dev",
  launchable: false,
  detect,
  isConfigured,
  configure,
};
