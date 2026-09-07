import { dirname } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { Document, isCollection, parseDocument } from "yaml";

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

/**
 * YAML sibling of {@link withJsonKeys}, for agents whose persistent config
 * is YAML (DeepSeek Harness' `settings.yaml`). Same contract: capture the
 * values at `keyPaths` (or their absence), run `fn`, restore just those.
 *
 * Edits go through the `yaml` Document API rather than parse → stringify,
 * so comments, key order, and quoting style elsewhere in the user's file
 * survive the round-trip — this is a file the agent's own docs tell users
 * to hand-edit.
 */
export async function withYamlKeys<T>(
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
  // A file that was ALREADY unparseable when we captured is one we can't have
  // written to (patchSettings refuses it), so the restore has nothing to undo
  // and no business warning about a block it never wrote.
  const beforeDoc = readYamlDocOrNull(path);
  const before = beforeDoc ?? new Document({});
  const valuesBefore = keyPaths.map((kp) => before.getIn(kp));
  try {
    return await fn();
  } finally {
    await restoreYaml(path, keyPaths, valuesBefore, fileExistedBefore, beforeMode, beforeDoc !== null);
  }
}

/**
 * Parse `path` into a Document, or null when a file exists that we cannot
 * read as a mapping. Use this for anything that writes the file back:
 * treating an unparseable document as empty means the write replaces
 * content we never saw — a hand-edited config with one typo in it would be
 * silently reduced to whatever keys we happen to set.
 */
export function readYamlDocOrNull(path: string): Document | null {
  if (!existsSync(path)) return new Document({});
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return null;
  if (doc.contents === null) return new Document({});
  return isCollection(doc.contents) ? doc : null;
}

/**
 * Parse `path` into a Document, falling back to an empty mapping for a
 * missing, unparseable, or non-mapping file — the YAML counterpart of
 * readJsonOrEmpty, and deliberately as forgiving. Read-only callers only;
 * writers want readYamlDocOrNull.
 */
export function readYamlDoc(path: string): Document {
  if (!existsSync(path)) return new Document({});
  try {
    const doc = parseDocument(readFileSync(path, "utf8"));
    if (doc.errors.length > 0 || !isCollection(doc.contents)) return new Document({});
    return doc;
  } catch {
    return new Document({});
  }
}

function isEmptyCollection(node: unknown): boolean {
  return isCollection(node) && node.items.length === 0;
}

// Walk back up the path and drop intermediate maps that are now empty —
// same cleanliness rule as the JSON variant, so removing our provider
// doesn't leave a bare `llm-pi-ai: providers: {}` husk behind.
function pruneEmptyAlongYamlPath(doc: Document, keyPath: string[]): void {
  for (let depth = keyPath.length - 1; depth >= 1; depth--) {
    const parentPath = keyPath.slice(0, depth);
    if (isEmptyCollection(doc.getIn(parentPath))) doc.deleteIn(parentPath);
  }
}

async function restoreYaml(
  path: string,
  keyPaths: string[][],
  valuesBefore: unknown[],
  fileExistedBefore: boolean,
  beforeMode: number | undefined,
  parseableBefore: boolean,
): Promise<void> {
  try {
    const after = readYamlDocOrNull(path);
    // Whatever left the file unparseable — the agent mid-write, a user edit,
    // an interrupted flush — rewriting it from an empty document would drop
    // every section we did not snapshot. Our keys are worth less than the
    // rest of the file, so leave it and say so.
    if (after === null) {
      if (parseableBefore) {
        process.stderr.write(
          `opper: ${path} is not readable as YAML after launch — leaving it untouched. ` +
            `Remove the Opper provider block by hand if it is still there.\n`,
        );
      }
      return;
    }
    for (let i = 0; i < keyPaths.length; i++) {
      const value = valuesBefore[i];
      if (value === undefined) after.deleteIn(keyPaths[i]!);
      else after.setIn(keyPaths[i]!, value);
    }
    for (const kp of keyPaths) {
      pruneEmptyAlongYamlPath(after, kp);
    }

    if (!fileExistedBefore && isEmptyCollection(after.contents)) {
      await rm(path, { force: true });
      return;
    }

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, after.toString(), beforeMode !== undefined ? { mode: beforeMode } : undefined);
    if (beforeMode !== undefined) await chmod(path, beforeMode);
  } catch (err) {
    process.stderr.write(
      `opper: failed to restore ${path} after launch: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
}
