import { dirname } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";

/**
 * Captures the contents (or absence) of `path`, runs `fn`, and restores
 * the file to its pre-`fn` state in a finally block — including when the
 * file didn't exist before (in which case "restore" means deleting it).
 *
 * Used by adapters that bake a per-launch session URL into a persistent
 * config file: snapshot ensures direct invocations of the agent (without
 * `opper launch`) don't inherit the previous session's URL.
 *
 * Restore failures are written to stderr but do not mask `fn`'s own error
 * — the caller's error is always more informative than a follow-up I/O
 * failure.
 */
export async function withConfigSnapshot<T>(
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  const snapshot = capture(path);
  try {
    return await fn();
  } finally {
    await restore(path, snapshot);
  }
}

interface Snapshot {
  existed: boolean;
  bytes?: Buffer;
  mode?: number;
}

function capture(path: string): Snapshot {
  if (!existsSync(path)) return { existed: false };
  const bytes = readFileSync(path);
  const mode = statSync(path).mode & 0o777;
  return { existed: true, bytes, mode };
}

async function restore(path: string, snap: Snapshot): Promise<void> {
  try {
    if (!snap.existed) {
      await rm(path, { force: true });
      return;
    }
    await mkdir(dirname(path), { recursive: true });
    // `writeFile`'s `mode` only applies when the file is being created.
    // If the agent rewrote the file in place (still exists), we have to
    // chmod explicitly to actually restore the original permissions.
    await writeFile(path, snap.bytes!, { mode: snap.mode });
    if (snap.mode !== undefined) await chmod(path, snap.mode);
  } catch (err) {
    process.stderr.write(
      `opper: failed to restore ${path} after launch: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
}
