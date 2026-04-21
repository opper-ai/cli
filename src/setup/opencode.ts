import { readFile, mkdir, writeFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { assetPath } from "../util/assets.js";
import { opencodeConfigPath, type Location } from "../util/editor-paths.js";

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

export async function configureOpenCode(
  opts: ConfigureOpenCodeOptions,
): Promise<ConfigureOpenCodeResult> {
  const path = opencodeConfigPath(opts.location);
  const template = readFileSync(assetPath("opencode.json"), "utf8");

  if (existsSync(path) && !opts.overwrite) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as {
        provider?: { opper?: unknown };
      };
      if (parsed.provider?.opper !== undefined) {
        return { path, wrote: false, reason: "exists" };
      }
    } catch {
      // unparseable existing config — safe to overwrite
    }
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, template, "utf8");
  return { path, wrote: true };
}
