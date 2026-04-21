import { readFile, mkdir, writeFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { assetPath } from "../util/assets.js";
import { continueConfigPath, type Location } from "../util/editor-paths.js";
import { OPPER_OPENAI_COMPAT_URL } from "../api/compat.js";

export interface ConfigureContinueOptions {
  location: Location;
  apiKey: string;
  overwrite?: boolean;
}

export interface ConfigureContinueResult {
  path: string;
  wrote: boolean;
  reason?: "exists";
}

interface ContinueConfig {
  models?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

export async function configureContinue(
  opts: ConfigureContinueOptions,
): Promise<ConfigureContinueResult> {
  const path = continueConfigPath(opts.location);
  const template = parse(readFileSync(assetPath("continue.yaml"), "utf8")) as {
    models: Array<Record<string, unknown>>;
  };

  let existing: ContinueConfig = {};
  if (existsSync(path)) {
    try {
      existing = (parse(await readFile(path, "utf8")) as ContinueConfig) ?? {};
    } catch {
      existing = {};
    }
  }

  const existingModels = Array.isArray(existing.models) ? existing.models : [];
  const hasOpper = existingModels.some(
    (m) => (m as { apiBase?: unknown }).apiBase === OPPER_OPENAI_COMPAT_URL,
  );
  if (hasOpper && !opts.overwrite) {
    return { path, wrote: false, reason: "exists" };
  }

  const keptModels = existingModels.filter(
    (m) => (m as { apiBase?: unknown }).apiBase !== OPPER_OPENAI_COMPAT_URL,
  );
  const opperModels = template.models.map((m) => ({
    ...m,
    apiKey: opts.apiKey,
  }));

  existing.models = [...keptModels, ...opperModels];

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringify(existing), "utf8");
  return { path, wrote: true };
}
