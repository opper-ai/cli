import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { which } from "../util/which.js";
import { OpperError } from "../errors.js";
import type {
  AgentAdapter,
  DetectResult,
  OpperRouting,
} from "./types.js";

const SENTINEL_OPEN = "# >>> opper-cli >>>";
const SENTINEL_CLOSE = "# <<< opper-cli <<<";
const COMPAT_BASE = "https://api.opper.ai/v3/compat";
const DEFAULT_PROFILE = "opper-opus";

const OPPER_BLOCK = [
  SENTINEL_OPEN,
  "# Managed by `opper`. Edits between these markers will be overwritten",
  "# the next time you reconfigure Codex via the Opper CLI.",
  "",
  "[model_providers.opper]",
  'name = "Opper"',
  `base_url = "${COMPAT_BASE}"`,
  'env_key = "OPPER_API_KEY"',
  'wire_api = "responses"',
  "",
  "[profiles.opper-opus]",
  'model = "anthropic/claude-opus-4.7"',
  'model_provider = "opper"',
  "",
  "[profiles.opper-sonnet]",
  'model = "anthropic/claude-sonnet-4.6"',
  'model_provider = "opper"',
  SENTINEL_CLOSE,
  "",
].join("\n");

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
  throw new OpperError(
    "AGENT_NOT_FOUND",
    "Codex must be installed manually.",
    "Install via `npm i -g @openai/codex` or see https://github.com/openai/codex.",
  );
}

async function isConfigured(): Promise<boolean> {
  const cfg = codexConfigPath();
  if (!existsSync(cfg)) return false;
  try {
    const text = readFileSync(cfg, "utf8");
    return (
      text.includes(SENTINEL_OPEN) && text.includes(`base_url = "${COMPAT_BASE}"`)
    );
  } catch {
    return false;
  }
}

async function configure(): Promise<void> {
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
  const padded =
    cleaned.length === 0
      ? OPPER_BLOCK
      : cleaned.endsWith("\n")
        ? cleaned + OPPER_BLOCK
        : `${cleaned}\n${OPPER_BLOCK}`;

  await mkdir(dirname(cfg), { recursive: true });
  await writeFile(cfg, padded, "utf8");
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
  // Ensure our provider/profile block is present (first-launch ergonomics).
  await configure();

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
