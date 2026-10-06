import { run } from "./run.js";
import { resolveWindowsCommand } from "./spawn.js";

/**
 * Returns the absolute path of `name` on PATH, or null if not found.
 * Uses the system `which` (or `where` on Windows) — no shell.
 */
export async function which(name: string): Promise<string | null> {
  if (process.platform === "win32") return resolveWindowsCommand(name) ?? null;
  const result = run("which", [name]);
  if (result.code !== 0) return null;
  const first = result.stdout.split(/\r?\n/)[0]?.trim();
  return first && first.length > 0 ? first : null;
}
