import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { confirm, isCancel, log } from "@clack/prompts";
import {
  vscodeUserSettingsPath,
  type VSCodeChannel,
} from "../util/editor-paths.js";
import { which } from "../util/which.js";
import { run } from "../util/run.js";
import { OpperError } from "../errors.js";
import { OPPER_COMPAT_URL } from "../config/endpoints.js";
import { PICKER_MODELS } from "../config/models.js";

export const COMMUNITY_EXTENSION_ID = "johnny-zhao.oai-compatible-copilot";
const COMMUNITY_EXTENSION_MARKETPLACE_URL =
  "https://marketplace.visualstudio.com/items?itemName=johnny-zhao.oai-compatible-copilot";

const DEFAULT_MAX_OUTPUT = 32_768;

// Conservative vision allowlist — only flip true for models we know report
// image input over Opper's compat endpoint. Users tweak by hand if needed.
const VISION = new Set<string>([
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "gpt-5.5",
  "gemini-3.1-pro-preview",
]);

const OWNED_BY = "opper";

/** Settings keys this adapter owns. Other `oaicopilot.*` keys are the user's
 * extension preferences and are left alone. */
export const OWNED_SETTING_KEYS = [
  "oaicopilot.baseUrl",
  "oaicopilot.models",
] as const;

interface OAIModelEntry {
  id: string;
  owned_by: string;
  displayName: string;
  apiMode: "openai";
  context_length: number;
  max_tokens: number;
  vision: boolean;
  enable_thinking: boolean;
}

function buildModelList(): OAIModelEntry[] {
  return PICKER_MODELS.map((m) => ({
    id: m.id,
    owned_by: OWNED_BY,
    displayName: m.id,
    apiMode: "openai",
    context_length: m.contextWindow,
    max_tokens: DEFAULT_MAX_OUTPUT,
    vision: VISION.has(m.id),
    enable_thinking: m.reasoning,
  }));
}

/**
 * Reports whether the OAI Compatible community extension is present in the
 * stable VS Code installation by querying `code --list-extensions`.
 */
export async function isCommunityExtensionInstalled(): Promise<boolean> {
  const codeBin = await which("code");
  if (!codeBin) return false;
  const result = run("code", ["--list-extensions"], {});
  if (result.code !== 0) return false;
  return result.stdout
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .includes(COMMUNITY_EXTENSION_ID.toLowerCase());
}

/**
 * Run `code --install-extension <id>`. Throws `AGENT_NOT_FOUND` when `code`
 * is missing or the install exits non-zero. No prompt — caller decides
 * whether to confirm with the user first.
 */
export async function installCommunityExtension(): Promise<void> {
  const codeBin = await which("code");
  if (!codeBin) {
    throw new OpperError(
      "AGENT_NOT_FOUND",
      "VS Code's `code` CLI was not found on PATH",
      "Open VS Code → Cmd+Shift+P → 'Shell Command: Install code in PATH', then re-run.",
    );
  }
  const result = run(
    "code",
    ["--install-extension", COMMUNITY_EXTENSION_ID],
    { inherit: true },
  );
  if (result.code !== 0) {
    throw new OpperError(
      "AGENT_NOT_FOUND",
      `Failed to install ${COMMUNITY_EXTENSION_ID} into VS Code`,
      `Run \`code --install-extension ${COMMUNITY_EXTENSION_ID}\` manually and re-run.`,
    );
  }
}

/**
 * Interactively offer to install the community extension. If the user
 * declines or cancels (Esc), throws a USER_CANCELLED error so the calling
 * configure step aborts cleanly without writing inert settings.
 */
async function confirmAndInstallExtension(): Promise<void> {
  log.info(
    [
      "Routing Copilot Chat through Opper requires a third-party VS Code extension:",
      `  • Extension: ${COMMUNITY_EXTENSION_ID}`,
      `  • Marketplace: ${COMMUNITY_EXTENSION_MARKETPLACE_URL}`,
      "",
      "It is community-maintained (not by Opper or Microsoft).",
    ].join("\n"),
  );

  const answer = await confirm({
    message: "Install it now?",
    initialValue: true,
  });
  if (isCancel(answer) || answer === false) {
    throw new OpperError(
      "USER_CANCELLED",
      "Configuration cancelled — community extension not installed.",
      `Install it manually with:\n  code --install-extension ${COMMUNITY_EXTENSION_ID}\nThen re-run \`opper editors github-copilot-vscode\`.`,
    );
  }

  await installCommunityExtension();
}

export interface GitHubCopilotVSCodeOptions {
  channel?: VSCodeChannel;
}

export interface ConfigureResult {
  path: string;
  wrote: boolean;
}

/**
 * Merge the Opper provider block into VS Code user `settings.json` so the
 * "OAI Compatible Provider for Copilot" community extension picks it up.
 *
 * If the extension is missing, we prompt the user before doing anything
 * else — without it the settings keys are inert. The prompt offers a
 * clean cancel path so the user can install manually.
 *
 * VS Code allows JSONC (// comments, trailing commas) in settings, but
 * `JSON.parse` rejects those. If parsing fails we throw so the user can
 * merge by hand — silently re-serialising would lose their comments.
 */
export async function configureGitHubCopilotVSCode(
  opts: GitHubCopilotVSCodeOptions = {},
): Promise<ConfigureResult> {
  const channel = opts.channel ?? "stable";

  if (!(await isCommunityExtensionInstalled())) {
    await confirmAndInstallExtension();
  }

  const path = vscodeUserSettingsPath(channel);

  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8").trim();
    if (raw.length > 0) {
      try {
        existing = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new Error(
          `Could not parse ${path} as JSON. If your settings file uses // comments or trailing commas, please add the Opper block manually for now (see docs/copilot-vscode/README.md).`,
        );
      }
    }
  }

  existing["oaicopilot.baseUrl"] = OPPER_COMPAT_URL;
  existing["oaicopilot.models"] = buildModelList();

  mkdirSync(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(existing, null, 4)}\n`, "utf8");
  return { path, wrote: true };
}

export interface UnconfigureResult {
  path: string;
  removed: boolean;
}

/**
 * Strip only the keys this adapter owns. Other `oaicopilot.*` keys (delay,
 * retry, commitLanguage, …) belong to the user's extension config and are
 * left in place.
 */
export async function unconfigureGitHubCopilotVSCode(
  opts: GitHubCopilotVSCodeOptions = {},
): Promise<UnconfigureResult> {
  const channel = opts.channel ?? "stable";
  const path = vscodeUserSettingsPath(channel);
  if (!existsSync(path)) return { path, removed: false };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return { path, removed: false };
  }

  let changed = false;
  for (const key of OWNED_SETTING_KEYS) {
    if (key in parsed) {
      delete parsed[key];
      changed = true;
    }
  }
  if (!changed) return { path, removed: false };

  await writeFile(path, `${JSON.stringify(parsed, null, 4)}\n`, "utf8");
  return { path, removed: true };
}

export function isGitHubCopilotVSCodeConfigured(
  channel: VSCodeChannel = "stable",
): boolean {
  const path = vscodeUserSettingsPath(channel);
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    return parsed["oaicopilot.baseUrl"] === OPPER_COMPAT_URL;
  } catch {
    return false;
  }
}
