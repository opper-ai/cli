import { run } from "./run.js";

/**
 * Returns the absolute path of `name` on PATH, or null if not found.
 * Uses the system `which` (or `where` on Windows) — no shell.
 */
export async function which(name: string): Promise<string | null> {
  const cmd = process.platform === "win32" ? "where" : "which";
  const result = run(cmd, [name]);
  if (result.code !== 0) return null;
  const first = result.stdout.split(/\r?\n/)[0]?.trim();
  return first && first.length > 0 ? first : null;
}
