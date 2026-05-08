import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { which } from "../util/which.js";
import { npmInstallGlobal } from "./npm-install.js";
import type {
  AgentAdapter,
  ConfigureOptions,
  DetectResult,
  OpperRouting,
} from "./types.js";

import { rm } from "node:fs/promises";

import { OPPER_COMPAT_URL } from "../config/endpoints.js";
import { PICKER_MODELS } from "../config/models.js";

const SENTINEL_OPEN = "# >>> opper-cli >>>";
const SENTINEL_CLOSE = "# <<< opper-cli <<<";
const DEFAULT_PROFILE = "opper-opus";

function buildOpperBlock(baseUrl: string): string {
  const profileBlocks = PICKER_MODELS.flatMap((m) => [
    "",
    `[profiles.opper-${m.codexProfile}]`,
    `model = "${m.id}"`,
    'model_provider = "opper"',
  ]);
  return [
    SENTINEL_OPEN,
    "# Managed by `opper`. Edits between these markers will be overwritten",
    "# the next time you reconfigure Codex via the Opper CLI.",
    "",
    "[model_providers.opper]",
    'name = "Opper"',
    `base_url = "${baseUrl}"`,
    'env_key = "OPPER_API_KEY"',
    'wire_api = "responses"',
    ...profileBlocks,
    SENTINEL_CLOSE,
    "",
  ].join("\n");
}

function codexConfigPath(): string {
  return join(homedir(), ".codex", "config.toml");
}

function stripOpperBlock(text: string): string {
  const startIdx = text.indexOf(SENTINEL_OPEN);
  if (startIdx === -1) return text;
  const endIdx = text.indexOf(SENTINEL_CLOSE, startIdx);
  if (endIdx === -1) return text;
  const before = text.slice(0, startIdx).replace(/\n$/, "");
  const after = text.slice(endIdx + SENTINEL_CLOSE.length).replace(/^\n/, "");
  if (before.length === 0) return after;
  return `${before}\n${after}`;
}

function extractOpperBlock(text: string): string | null {
  const startIdx = text.indexOf(SENTINEL_OPEN);
  if (startIdx === -1) return null;
  const endIdx = text.indexOf(SENTINEL_CLOSE, startIdx);
  if (endIdx === -1) return null;
  return text.slice(startIdx, endIdx + SENTINEL_CLOSE.length);
}

// Snapshot/restore variants that target the LAST opener-closer pair in
// the file. `writeOpperBlock` always appends our block at the end, so
// post-spawn the well-formed block is the last one. Using indexOf-first
// for restore would cross-match a stale unclosed opener with our new
// closer and strip user data between them.
function extractLastOpperBlock(text: string): string | null {
  const startIdx = text.lastIndexOf(SENTINEL_OPEN);
  if (startIdx === -1) return null;
  const endIdx = text.indexOf(SENTINEL_CLOSE, startIdx);
  if (endIdx === -1) return null;
  return text.slice(startIdx, endIdx + SENTINEL_CLOSE.length);
}

function stripLastOpperBlock(text: string): string {
  const startIdx = text.lastIndexOf(SENTINEL_OPEN);
  if (startIdx === -1) return text;
  const endIdx = text.indexOf(SENTINEL_CLOSE, startIdx);
  if (endIdx === -1) return text;
  const before = text.slice(0, startIdx).replace(/\n$/, "");
  const after = text.slice(endIdx + SENTINEL_CLOSE.length).replace(/^\n/, "");
  if (before.length === 0) return after;
  return `${before}\n${after}`;
}

async function detect(): Promise<DetectResult> {
  const path = await which("codex");
  if (!path) return { installed: false };
  return {
    installed: true,
    configPath: codexConfigPath(),
  };
}

async function install(): Promise<void> {
  await npmInstallGlobal("@openai/codex", "https://github.com/openai/codex");
}

async function isConfigured(): Promise<boolean> {
  const cfg = codexConfigPath();
  if (!existsSync(cfg)) return false;
  try {
    const text = readFileSync(cfg, "utf8");
    // Match the sentinel + the start of the base_url line, but don't pin
    // the URL value — at launch we rewrite it to the per-session URL.
    return (
      text.includes(SENTINEL_OPEN) && /base_url = "/.test(text)
    );
  } catch {
    return false;
  }
}

async function writeOpperBlock(baseUrl: string): Promise<void> {
  const cfg = codexConfigPath();
  let existing = "";
  if (existsSync(cfg)) {
    try {
      existing = readFileSync(cfg, "utf8");
    } catch {
      existing = "";
    }
  }
  const cleaned = stripOpperBlock(existing);
  const block = buildOpperBlock(baseUrl);
  const padded =
    cleaned.length === 0
      ? block
      : cleaned.endsWith("\n")
        ? cleaned + block
        : `${cleaned}\n${block}`;

  await mkdir(dirname(cfg), { recursive: true });
  await writeFile(cfg, padded, "utf8");
}

async function configure(_opts: ConfigureOptions): Promise<void> {
  // Configure-only flow (menu / `opper agents`): bake in the default
  // compat URL. At launch time `spawn` rewrites the block with the
  // session-specific URL.
  void _opts;
  await writeOpperBlock(OPPER_COMPAT_URL);
}

async function unconfigure(): Promise<void> {
  const cfg = codexConfigPath();
  if (!existsSync(cfg)) return;
  let text: string;
  try {
    text = readFileSync(cfg, "utf8");
  } catch {
    return;
  }
  if (!text.includes(SENTINEL_OPEN)) return;
  await writeFile(cfg, stripOpperBlock(text), "utf8");
}

function hasProfileArg(args: string[]): boolean {
  return args.some(
    (a) =>
      a === "--profile" ||
      a === "-p" ||
      a.startsWith("--profile=") ||
      a.startsWith("-p="),
  );
}

async function spawn(args: string[], routing: OpperRouting): Promise<number> {
  // Narrow snapshot: capture just the sentinel-delimited opper block (or
  // its absence). On exit we restore that block on top of whatever the
  // file looks like by then — anything outside the sentinels (user
  // edits to [settings], theme, etc.) is preserved.
  const cfg = codexConfigPath();
  const fileExistedBefore = existsSync(cfg);
  // Tolerate read failures (perm, transient I/O) — same baseline as
  // writeOpperBlock, which falls back to empty on read errors. A
  // hard fail here would regress launch for users with unreadable
  // configs.
  let opperBlockBefore: string | null = null;
  if (fileExistedBefore) {
    try {
      // Use lastIndexOf so a stale unclosed opener earlier in the file
      // doesn't cause us to capture (and later restore) unrelated user
      // content as part of the "block".
      opperBlockBefore = extractLastOpperBlock(readFileSync(cfg, "utf8"));
    } catch {
      opperBlockBefore = null;
    }
  }

  await writeOpperBlock(routing.baseUrl);
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPPER_API_KEY: routing.apiKey,
    };
    const finalArgs = hasProfileArg(args)
      ? args
      : ["--profile", DEFAULT_PROFILE, ...args];
    const result = spawnSync("codex", finalArgs, { stdio: "inherit", env });
    return result.status ?? -1;
  } finally {
    await restoreOpperBlock(cfg, opperBlockBefore, fileExistedBefore);
  }
}

async function restoreOpperBlock(
  cfg: string,
  blockBefore: string | null,
  fileExistedBefore: boolean,
): Promise<void> {
  try {
    const current = existsSync(cfg) ? readFileSync(cfg, "utf8") : "";
    // Use lastIndexOf-based strip: writeOpperBlock appended our block
    // at the end, so stripping the LAST opener-closer pair removes
    // exactly what we wrote. indexOf-first would cross-match a stale
    // unclosed opener with our new closer and erase user data between.
    const stripped = stripLastOpperBlock(current);
    let next: string;
    if (blockBefore === null) {
      next = stripped;
    } else if (stripped.length === 0) {
      next = `${blockBefore}\n`;
    } else {
      next = stripped.endsWith("\n")
        ? `${stripped}${blockBefore}\n`
        : `${stripped}\n${blockBefore}\n`;
    }
    if (!fileExistedBefore && next.trim().length === 0) {
      await rm(cfg, { force: true });
      return;
    }
    await mkdir(dirname(cfg), { recursive: true });
    await writeFile(cfg, next, "utf8");
  } catch (err) {
    process.stderr.write(
      `opper: failed to restore ${cfg} after launch: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
}

export const codex: AgentAdapter = {
  name: "codex",
  displayName: "Codex",
  docsUrl: "https://github.com/openai/codex",
  detect,
  isConfigured,
  configure,
  unconfigure,
  install,
  spawn,
};
