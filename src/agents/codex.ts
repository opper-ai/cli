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

import { OPPER_COMPAT_URL } from "../config/endpoints.js";
import { DEFAULT_MODELS } from "../config/models.js";

const SENTINEL_OPEN = "# >>> opper-cli >>>";
const SENTINEL_CLOSE = "# <<< opper-cli <<<";
const DEFAULT_PROFILE = "opper-opus";

function buildOpperBlock(baseUrl: string): string {
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
    "",
    "[profiles.opper-opus]",
    `model = "${DEFAULT_MODELS.opus}"`,
    'model_provider = "opper"',
    "",
    "[profiles.opper-sonnet]",
    `model = "${DEFAULT_MODELS.sonnet}"`,
    'model_provider = "opper"',
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
  // Rewrite our provider/profile block on every launch so the latest
  // session URL (and any tags it carries) is the active base_url.
  await writeOpperBlock(routing.baseUrl);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPPER_API_KEY: routing.apiKey,
  };
  const finalArgs = hasProfileArg(args)
    ? args
    : ["--profile", DEFAULT_PROFILE, ...args];
  const result = spawnSync("codex", finalArgs, { stdio: "inherit", env });
  return result.status ?? -1;
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
