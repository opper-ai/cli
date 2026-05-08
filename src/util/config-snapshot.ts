import { dirname } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";

/**
 * Snapshot the value at `keyPath` in a JSON file (or its absence), run
 * `fn`, then restore just that key to its pre-`fn` state. Other keys —
 * including ones added or modified during `fn` (e.g. by the launched
 * agent or a concurrent user edit) — are preserved.
 *
 * Used by adapters that bake a per-launch session URL into a persistent
 * config: snapshot ensures direct invocations of the agent (without
 * `opper launch`) don't inherit the previous session's URL, while the
 * narrow scope keeps unrelated mid-spawn config changes intact.
 *
 * If the file didn't exist before `fn` and is structurally empty after
 * removing our key, it gets deleted on restore.
 *
 * Restore failures go to stderr but do not mask `fn`'s own error.
 */
export async function withJsonKey<T>(
  path: string,
  keyPath: string[],
  fn: () => Promise<T>,
): Promise<T> {
  if (keyPath.length === 0) throw new Error("keyPath must be non-empty");
  const fileExistedBefore = existsSync(path);
  const beforeMode = fileExistedBefore
    ? statSync(path).mode & 0o777
    : undefined;
  const valueBefore = readKey(readJsonOrEmpty(path), keyPath);
  try {
    return await fn();
  } finally {
    await restore(path, keyPath, valueBefore, fileExistedBefore, beforeMode);
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
  keyPath: string[],
  valueBefore: unknown,
  fileExistedBefore: boolean,
  beforeMode: number | undefined,
): Promise<void> {
  try {
    const after = readJsonOrEmpty(path);
    setKey(after, keyPath, valueBefore);
    pruneEmptyAlongPath(after, keyPath);

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
