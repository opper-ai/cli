import { dirname } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { applyEdits, modify } from "jsonc-parser";
import { OpperError } from "../errors.js";
import { deleteJsoncProperty, parseJsoncObject } from "./jsonc.js";

/**
 * Snapshot the values at one or more `keyPaths` in a JSON/JSONC file (or
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
  const before = readJsoncOrEmpty(path);
  const valuesBefore = keyPaths.map((kp) => readKey(before.value, kp));
  try {
    return await fn();
  } finally {
    await restore(path, keyPaths, valuesBefore, before.value, fileExistedBefore, beforeMode);
  }
}

function readJsoncOrEmpty(path: string): { text: string; value: Record<string, unknown> } {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "{}";
  return { text, value: parseObject(text, path) };
}

function parseObject(text: string, path: string): Record<string, unknown> {
  try {
    return parseJsoncObject(text);
  } catch {
    throw new OpperError(
      "AGENT_CONFIG_CONFLICT",
      `Cannot safely restore ${path}: expected a valid JSON or JSONC object. Existing configuration was preserved.`,
    );
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

async function restore(
  path: string,
  keyPaths: string[][],
  valuesBefore: unknown[],
  valueBefore: Record<string, unknown>,
  fileExistedBefore: boolean,
  beforeMode: number | undefined,
): Promise<void> {
  try {
    const after = readJsoncOrEmpty(path);
    let text = after.text;
    let value = after.value;
    const setKey = (keyPath: string[], next: unknown): void => {
      if (isDeepStrictEqual(readKey(value, keyPath), next)) return;
      // Edit only the scoped value so comments, formatting, and runtime edits
      // elsewhere in the document survive restoration.
      text = next === undefined
        ? deleteJsoncProperty(text, keyPath)
        : applyEdits(text, modify(text, keyPath, next, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        }));
      value = parseObject(text, path);
    };
    for (let i = 0; i < keyPaths.length; i++) {
      setKey(keyPaths[i]!, valuesBefore[i]);
    }
    for (const kp of keyPaths) {
      // Drop parents left empty by removing a temporary key, as on first launch.
      for (let depth = kp.length - 1; depth >= 1; depth--) {
        const parentPath = kp.slice(0, depth);
        const child = readKey(value, parentPath);
        if (readKey(valueBefore, parentPath) === undefined && child !== null && typeof child === "object" && !Array.isArray(child) && Object.keys(child).length === 0) {
          setKey(parentPath, undefined);
        }
      }
    }

    if (!fileExistedBefore && Object.keys(value).length === 0) {
      await rm(path, { force: true });
      return;
    }

    await mkdir(dirname(path), { recursive: true });
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
