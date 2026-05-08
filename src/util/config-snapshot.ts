import { dirname } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";

/**
 * Snapshot the values at one or more `keyPaths` in a JSON file (or
 * their absence), run `fn`, then restore just those keys to their
 * pre-`fn` state. Other keys — including ones added or modified during
 * `fn` (e.g. by the launched agent or a concurrent user edit) — are
 * preserved.
 *
 * Used by adapters that bake a per-launch session URL into a persistent
 * config: snapshot ensures direct invocations of the agent (without
 * `opper launch`) don't inherit the previous session's URL, while the
 * narrow scope keeps unrelated mid-spawn config changes intact.
 *
 * If the file didn't exist before `fn` and is structurally empty after
 * the captured keys are restored, it gets deleted.
 *
 * Restore failures go to stderr but do not mask `fn`'s own error.
 */
export async function withJsonKeys<T>(
  path: string,
  keyPaths: string[][],
  fn: () => Promise<T>,
): Promise<T> {
  if (keyPaths.length === 0) throw new Error("keyPaths must be non-empty");
  for (const kp of keyPaths) {
    if (kp.length === 0) throw new Error("each keyPath must be non-empty");
  }
  const fileExistedBefore = existsSync(path);
  let beforeMode: number | undefined;
  if (fileExistedBefore) {
    try {
      beforeMode = statSync(path).mode & 0o777;
    } catch {
      beforeMode = undefined;
    }
  }
  const before = readJsonOrEmpty(path);
  const valuesBefore = keyPaths.map((kp) => readKey(before, kp));
  try {
    return await fn();
  } finally {
    await restore(path, keyPaths, valuesBefore, fileExistedBefore, beforeMode);
  }
}

function readJsonOrEmpty(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readKey(obj: Record<string, unknown>, keyPath: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keyPath) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function setKey(
  obj: Record<string, unknown>,
  keyPath: string[],
  value: unknown,
): void {
  let cur = obj;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const k = keyPath[i]!;
    const next = cur[k];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  const last = keyPath[keyPath.length - 1]!;
  if (value === undefined) delete cur[last];
  else cur[last] = value;
}

// Walk back up the path and drop intermediate objects that are now empty —
// keeps post-restore JSON clean when our key was the only inhabitant of
// `providers` / `provider`, etc.
function pruneEmptyAlongPath(
  obj: Record<string, unknown>,
  keyPath: string[],
): void {
  for (let depth = keyPath.length - 1; depth >= 1; depth--) {
    let parent: Record<string, unknown> = obj;
    for (let j = 0; j < depth - 1; j++) {
      const next = parent[keyPath[j]!];
      if (next === null || typeof next !== "object") return;
      parent = next as Record<string, unknown>;
    }
    const childKey = keyPath[depth - 1]!;
    const child = parent[childKey];
    if (
      child !== null &&
      typeof child === "object" &&
      !Array.isArray(child) &&
      Object.keys(child as Record<string, unknown>).length === 0
    ) {
      delete parent[childKey];
    }
  }
}

async function restore(
  path: string,
  keyPaths: string[][],
  valuesBefore: unknown[],
  fileExistedBefore: boolean,
  beforeMode: number | undefined,
): Promise<void> {
  try {
    const after = readJsonOrEmpty(path);
    for (let i = 0; i < keyPaths.length; i++) {
      setKey(after, keyPaths[i]!, valuesBefore[i]);
    }
    for (const kp of keyPaths) {
      pruneEmptyAlongPath(after, kp);
    }

    if (!fileExistedBefore && Object.keys(after).length === 0) {
      await rm(path, { force: true });
      return;
    }

    await mkdir(dirname(path), { recursive: true });
    const text = JSON.stringify(after, null, 2) + "\n";
    await writeFile(path, text, beforeMode !== undefined ? { mode: beforeMode } : undefined);
    if (beforeMode !== undefined) await chmod(path, beforeMode);
  } catch (err) {
    process.stderr.write(
      `opper: failed to restore ${path} after launch: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
}
