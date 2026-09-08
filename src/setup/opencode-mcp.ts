import { existsSync, readFileSync } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isIP } from "node:net";
import { applyEdits, getNodeValue, modify, parseTree, type Node, type ParseError } from "jsonc-parser";
import { OpperError } from "../errors.js";
import { OPPER_HOST } from "../config/endpoints.js";
import { opencodeConfigPath, type Location } from "../util/editor-paths.js";
import type { ConfigureOpenCodeResult } from "./opencode.js";

const DEFAULT_MCP_URL = `${OPPER_HOST}/mcp`;
const MCP_SCOPES = new Set([
  "account:read", "projects:read", "projects:write", "projects:delete",
  "apikeys:read", "apikeys:write", "controls:read", "controls:write",
  "dynamic_routes:read", "dynamic_routes:write", "runtime:read", "runtime:call",
]);

type Config = Record<string, unknown>;
type Document = { path: string; text: string; config: Config };

function record(value: unknown): value is Config {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function selectedScopes(value: string): string {
  const scopes = [...new Set(value.trim().split(/\s+/u))].sort();
  if (scopes.some((scope) => !MCP_SCOPES.has(scope))) {
    throw new OpperError("INVALID_ARGUMENT", "Invalid MCP scope selection.",
      `Pass a quoted, space-separated selection from: ${[...MCP_SCOPES].join(" ")}.`);
  }
  return scopes.join(" ");
}

export function validateMcpUrl(value: string): string {
  try {
    if (!value || /\s|\\/u.test(value)) throw new Error();
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" ||
      (isIP(url.hostname) === 4 && url.hostname.startsWith("127."));
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      !url.hostname || url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString();
  } catch {
    throw new OpperError("INVALID_ARGUMENT", "Invalid MCP URL.",
      "Use an HTTPS endpoint, or HTTP on localhost for local development, without credentials, query parameters, or fragments.");
  }
}

function configConflict(path: string): OpperError {
  return new OpperError("AGENT_CONFIG_CONFLICT", `Cannot safely update OpenCode config at ${path}.`,
    "Fix invalid JSON/JSONC, duplicate keys, or non-object provider/mcp settings, then retry. No files were changed.");
}

/** Capture before replacing: editor saves are retained, never truncated. */
async function replaceExistingConfig(path: string, expected: string, updated: string): Promise<string> {
  if (!(await lstat(path)).isFile()) {
    throw new OpperError("AGENT_CONFIG_CONFLICT", `Cannot safely replace non-regular OpenCode config at ${path}.`,
      "The file was not changed. Merge the MCP entry manually for a symlinked config.");
  }
  const directory = await mkdtemp(join(dirname(path), ".opper-mcp-"));
  const staged = join(directory, "updated");
  const backup = join(directory, `${basename(path)}.backup`);
  let captured = false;
  try {
    const handle = await open(staged, "wx", 0o600);
    try { await handle.writeFile(updated); await handle.sync(); }
    finally { await handle.close(); }
    // rename captures the current inode atomically, including an editor save
    // after our earlier read. Keep it even after success: an already-open
    // descriptor may still write to that inode after the comparison below.
    await rename(path, backup);
    captured = true;
    const capturedInfo = await lstat(backup);
    if (!capturedInfo.isFile() || await readFile(backup, "utf8") !== expected) {
      throw new Error("The captured configuration changed during setup");
    }
    await chmod(staged, capturedInfo.mode & 0o777);
    // An editor may recreate the original path while it is absent. Never
    // replace that save, either while installing or restoring after failure.
    await link(staged, path);
    return backup;
  } catch (error) {
    if (captured) {
      let restored = false;
      try { await link(backup, path); restored = true; } catch { /* Keep both files for recovery. */ }
      throw new OpperError("AGENT_CONFIG_CONFLICT", `OpenCode configuration could not be safely updated at ${path}.`,
        `The captured config is preserved at ${backup}. ${restored ? "It was restored to the original path." : "Any file now at the original path was left untouched."} Review the files and retry setup.`);
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw configConflict(path);
    throw error;
  } finally {
    await rm(staged, { force: true });
    if (!captured) await rm(directory, { recursive: true, force: true });
  }
}

function checkDuplicateKeys(node: Node, path: string): void {
  if (node.type === "object") {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value as string;
      if (keys.has(key)) throw configConflict(path);
      keys.add(key);
    }
  }
  for (const child of node.children ?? []) checkDuplicateKeys(child, path);
}

function readDocument(path: string): Document {
  const text = readFileSync(path, "utf8");
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true });
  if (!tree || errors.length || tree.type !== "object") throw configConflict(path);
  checkDuplicateKeys(tree, path);
  const config = getNodeValue(tree) as Config;
  for (const name of ["provider", "mcp"]) {
    if (config[name] !== undefined && !record(config[name])) throw configConflict(path);
  }
  return { path, text, config };
}

// OpenCode 1.18.29 merges object values recursively, JSONC after JSON.
// Only inspecting the writable file would miss an existing provider or an
// MCP URL whose enabled/auth preferences are overridden in a later file.
function merge(base: Config, override: Config): Config {
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(override)])].map((key) => {
    const first = base[key];
    const next = override[key];
    return [key, record(first) && record(next) ? merge(first, next) :
      Object.hasOwn(override, key) ? next : first];
  }));
}

function effectiveLayer(config: Config): Config {
  if (!record(config.mcp)) return config;
  // OpenCode's untyped enabled-only variant strips every other field before
  // merging, including a stray scope written by older setup versions.
  return { ...config, mcp: Object.fromEntries(Object.entries(config.mcp).map(([name, entry]) => [
    name, record(entry) && entry.type === undefined && typeof entry.enabled === "boolean"
      ? { enabled: entry.enabled } : entry,
  ])) };
}

/** Add an account MCP connection; this never configures inference or logs in. */
export async function configureOpenCodeMcp(
  location: Location,
  requestedUrl = DEFAULT_MCP_URL,
  requestedScopes?: string,
): Promise<ConfigureOpenCodeResult> {
  const url = validateMcpUrl(requestedUrl);
  const scopes = requestedScopes === undefined ? undefined : selectedScopes(requestedScopes);
  const jsonPath = opencodeConfigPath(location);
  const directory = dirname(jsonPath);
  const candidates = location === "global"
    ? [join(directory, "config.json"), jsonPath, `${jsonPath}c`]
    : [jsonPath, `${jsonPath}c`];
  // Read and validate every local layer before planning the single file edit.
  // There is no provider/model rewrite and no evaluation of {env:...} tokens.
  const documents = candidates.filter(existsSync).map(readDocument);
  const effective = documents.reduce((config, document) => merge(config, effectiveLayer(document.config)), {} as Config);
  const servers = record(effective.mcp) ? effective.mcp : {};
  let target = documents.find((document) => document.path === `${jsonPath}c`) ??
    documents.find((document) => document.path === jsonPath) ??
    { path: jsonPath, text: "{\n}\n", config: {} };
  let mcpName = "opper";
  let mcpEnabled = true;
  let mcpOAuthEnabled = true;
  let existing = false;
  for (const [name, settings] of Object.entries(servers)) {
    if (record(settings) && settings.type === "remote" && settings.url === url) {
      if (/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u.test(name)) {
        throw new OpperError("AGENT_CONFIG_CONFLICT", "The matching MCP server name contains non-printable characters.",
          "Rename it using printable characters in OpenCode, then retry. Existing settings were preserved.");
      }
      mcpName = name;
      mcpEnabled = settings.enabled !== false;
      mcpOAuthEnabled = settings.oauth !== false;
      existing = true;
      if (scopes !== undefined) {
        // OpenCode validates each file before merging. A scope-only entry is
        // invalid, or its fields are discarded as an enabled-only override.
        // Edit the latest complete definition without copying private headers
        // or OAuth settings into a potentially less-restricted config file.
        target = [...documents].reverse().find((document) => {
          const entries = document.config.mcp;
          const entry = record(entries) ? entries[name] : undefined;
          return record(entry) && entry.type === "remote" && entry.url === url;
        }) ?? target;
      }
      if (scopes !== undefined && settings.oauth !== undefined && !record(settings.oauth)) {
        throw new OpperError("AGENT_CONFIG_CONFLICT", "Cannot select scopes while this MCP server's OAuth is disabled or invalid.",
          "Review its OAuth settings in OpenCode, then retry. Existing settings were preserved.");
      }
      if (scopes === undefined || (record(settings.oauth) && settings.oauth.scope === scopes)) {
        return { path: target.path, wrote: false, reason: "exists", mcpName, mcpEnabled, mcpOAuthEnabled,
          ...(scopes !== undefined ? { mcpScopes: scopes } : {}) };
      }
      break;
    }
  }
  if (!existing && Object.hasOwn(servers, "opper")) {
    throw new OpperError("AGENT_CONFIG_CONFLICT", "An OpenCode MCP server named opper already uses different settings.",
      "Edit or rename that entry in OpenCode before adding this endpoint. --overwrite applies only to inference provider setup.");
  }
  // Omit a scope restriction by default so Opper's consent page can offer
  // permissions discovered by the client. Only explicit selections belong
  // in the client config; existing restrictions are preserved above.
  const entry = { type: "remote", url, enabled: true,
    ...(scopes !== undefined ? { oauth: { scope: scopes } } : {}) };
  const editPath = existing ? ["mcp", mcpName, "oauth", "scope"] : ["mcp", mcpName];
  const updated = applyEdits(target.text, modify(target.text, editPath, existing ? scopes : entry, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: target.text.includes("\r\n") ? "\r\n" : "\n" },
  }));
  // A user/editor may save while configuration is being inspected. Refuse
  // to clobber a changed layer, including a newly created target file.
  for (const candidate of candidates) {
    const original = documents.find((document) => document.path === candidate);
    if (existsSync(candidate) !== Boolean(original) ||
      (original && readFileSync(candidate, "utf8") !== original.text)) throw configConflict(candidate);
  }
  await mkdir(directory, { recursive: true });
  let backupPath: string | undefined;
  if (documents.some((document) => document.path === target.path)) {
    backupPath = await replaceExistingConfig(target.path, target.text, updated);
  } else {
    try {
      await writeFile(target.path, updated, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw configConflict(target.path);
      throw error;
    }
  }
  return { path: target.path, wrote: true, mcpName, mcpEnabled, mcpOAuthEnabled,
    ...(backupPath !== undefined ? { backupPath } : {}),
    ...(scopes !== undefined ? { mcpScopes: scopes } : {}) };
}
