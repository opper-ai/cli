import { which } from "../util/which.js";
import { vscodeUserSettingsPath } from "../util/editor-paths.js";
import {
  configureGitHubCopilotVSCode,
  unconfigureGitHubCopilotVSCode,
  isGitHubCopilotVSCodeConfigured,
  installCommunityExtension,
  COMMUNITY_EXTENSION_ID,
} from "../setup/github-copilot-vscode.js";
import type { AgentAdapter, DetectResult, ConfigureOptions } from "./types.js";
import { OpperError } from "../errors.js";

/**
 * Routes GitHub Copilot Chat in VS Code through Opper via the
 * "OAI Compatible Provider for Copilot" community extension. Configure-only:
 * the user opens VS Code themselves; we just write the Opper provider block
 * into user `settings.json`.
 *
 * `configure()` prompts the user before installing the third-party
 * extension if it's missing — see `confirmAndInstallExtension` in
 * `setup/github-copilot-vscode.ts`.
 *
 * Stable-channel only for now. Insiders' native BYOK flow
 * (`github.copilot.chat.customOAIModels`) is deprecated upstream and lives
 * behind a one-shot migration that no longer reads on subsequent edits.
 */

export { COMMUNITY_EXTENSION_ID };

async function detect(): Promise<DetectResult> {
  const codeBin = await which("code");
  if (!codeBin) return { installed: false };
  return {
    installed: true,
    configPath: vscodeUserSettingsPath("stable"),
  };
}

async function install(): Promise<void> {
  await installCommunityExtension();
}

async function isConfigured(): Promise<boolean> {
  return isGitHubCopilotVSCodeConfigured("stable");
}

async function configure(opts: ConfigureOptions = {}): Promise<void> {
  if (opts.projectUuid) throw new OpperError("INVALID_ARGUMENT", "VS Code Copilot setup does not support an explicit project target.", "Use organization inference without --project-uuid, or launch a supported agent with the target.");
  await configureGitHubCopilotVSCode({ channel: "stable" });
}

async function unconfigure(): Promise<void> {
  await unconfigureGitHubCopilotVSCode({ channel: "stable" });
}

export const githubCopilotVSCode: AgentAdapter = {
  name: "github-copilot-vscode",
  displayName: "GitHub Copilot (VS Code)",
  docsUrl: "https://github.com/features/copilot",
  detect,
  isConfigured,
  configure,
  unconfigure,
  install,
  // No spawn — user opens VS Code themselves; Opper models appear in the
  // Copilot Chat picker on next session.
};
