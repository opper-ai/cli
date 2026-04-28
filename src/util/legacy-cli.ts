import { realpathSync } from "node:fs";
import { run } from "./run.js";

export interface LegacyOpperCli {
  /** Path of the legacy binary (the Cellar entry, not the symlink). */
  path: string;
  /** True when this entry comes before our own `opper` on PATH. */
  shadowsUs: boolean;
}

/**
 * Detect a Homebrew-installed legacy Go `opper` CLI on PATH. The Go CLI
 * lived at github.com/opper-ai/oppercli (formula `opper-ai/oppercli/opper`)
 * and provides the same `opper` binary name as we do, so when both are
 * installed PATH order decides which one runs. Catches that and returns
 * the resolved Cellar path so callers can warn the user.
 */
export function detectLegacyOpperCli(): LegacyOpperCli | null {
  if (process.platform === "win32") return null;

  const result = run("which", ["-a", "opper"]);
  if (result.code !== 0) return null;

  const candidates = result.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (let i = 0; i < candidates.length; i++) {
    const path = candidates[i]!;
    let resolved: string;
    try {
      resolved = realpathSync(path);
    } catch {
      resolved = path;
    }
    // Both Apple Silicon (/opt/homebrew/Cellar/) and Intel
    // (/usr/local/Cellar/) layouts land on this substring.
    if (resolved.includes("/Cellar/opper/")) {
      return { path: resolved, shadowsUs: i === 0 };
    }
  }
  return null;
}
