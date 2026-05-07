import { readFile, mkdir, writeFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { assetPath } from "../util/assets.js";
import { opencodeConfigPath, type Location } from "../util/editor-paths.js";

export interface ProjectConfigState {
  exists: boolean;
  hasOpperProvider: boolean;
}

/**
 * Inspect the cwd-local `opencode.json` (if any). Used at launch time to
 * decide whether to warn that a project-level config will shadow whatever
 * we just wrote to the user-level config.
 */
export function readProjectConfigState(path: string): ProjectConfigState {
  if (!existsSync(path)) return { exists: false, hasOpperProvider: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      provider?: { opper?: unknown };
    };
    return {
      exists: true,
      hasOpperProvider: parsed?.provider?.opper !== undefined,
    };
  } catch {
    return { exists: true, hasOpperProvider: false };
  }
}

export interface ConfigureOpenCodeOptions {
  location: Location;
  /** If the destination already has an Opper provider, rewrite it. */
  overwrite?: boolean;
}

export interface ConfigureOpenCodeResult {
  path: string;
  wrote: boolean;
  reason?: "exists";
}

// NOTE: OpenCode's template uses `{env:OPPER_API_KEY}` placeholders so the
// editor resolves the key from the environment at read time — no post-write
// mutation. The launch flow exports OPPER_API_KEY before spawning OpenCode.
//
// When the user already has an opencode.json (their own model defaults, theme,
// other providers, agents, keybinds), we graft just our `provider.opper` block
// into it instead of replacing the whole file. Wholesale overwriting wiped
// user customisations on first launch.
export async function configureOpenCode(
  opts: ConfigureOpenCodeOptions,
): Promise<ConfigureOpenCodeResult> {
  const path = opencodeConfigPath(opts.location);
  const template = readFileSync(assetPath("opencode.json"), "utf8");
  const templateConfig = JSON.parse(template) as {
    provider: { opper: unknown };
  };

  await mkdir(dirname(path), { recursive: true });

  if (existsSync(path)) {
    let existing: Record<string, unknown> | null = null;
    try {
      existing = JSON.parse(await readFile(path, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      // unparseable — fall through and replace with template
    }

    if (existing && typeof existing === "object") {
      const providers =
        existing.provider && typeof existing.provider === "object"
          ? (existing.provider as Record<string, unknown>)
          : {};

      if (providers.opper !== undefined && !opts.overwrite) {
        return { path, wrote: false, reason: "exists" };
      }

      const merged = {
        ...existing,
        provider: { ...providers, opper: templateConfig.provider.opper },
      };
      await writeFile(path, JSON.stringify(merged, null, 2), "utf8");
      return { path, wrote: true };
    }
  }

  await writeFile(path, template, "utf8");
  return { path, wrote: true };
}
