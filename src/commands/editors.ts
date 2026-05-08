import { configureOpenCode } from "../setup/opencode.js";
import {
  configureGitHubCopilotVSCode,
  unconfigureGitHubCopilotVSCode,
} from "../setup/github-copilot-vscode.js";
import { githubCopilotVSCode } from "../agents/github-copilot-vscode.js";
import { listAdapters } from "../agents/registry.js";
import { isLaunchable } from "../agents/types.js";
import { brand } from "../ui/colors.js";
import { OpperError } from "../errors.js";
import type { Location } from "../util/editor-paths.js";

export interface EditorsOpenCodeOptions {
  location: Location;
  overwrite: boolean;
}


/**
 * Lists configure-only integrations from the agents registry. Anything in
 * the registry without a `spawn` method is "an editor" for this command's
 * purposes; launchable agents show up via `opper agents list`.
 */
export async function editorsListCommand(): Promise<void> {
  const editors = listAdapters().filter((a) => !isLaunchable(a));
  if (editors.length === 0) {
    console.log("(no editor integrations registered)");
    return;
  }
  for (const adapter of editors) {
    const configured = await adapter.isConfigured();
    const status = configured
      ? brand.accent("configured")
      : brand.dim("not configured");
    console.log(
      `${adapter.displayName.padEnd(14)} ${status}  ${brand.dim(adapter.docsUrl)}`,
    );
  }
}

export async function editorsOpenCodeCommand(
  opts: EditorsOpenCodeOptions,
): Promise<void> {
  const result = await configureOpenCode({
    location: opts.location,
    ...(opts.overwrite ? { overwrite: true } : {}),
  });
  if (!result.wrote && result.reason === "exists") {
    console.log(
      `OpenCode config at ${result.path} already has an Opper provider. Pass --overwrite to replace it.`,
    );
    return;
  }
  console.log(brand.accent(`✓ Wrote OpenCode config to ${result.path}.`));
}

export async function editorsGitHubCopilotVSCodeCommand(): Promise<void> {
  const detect = await githubCopilotVSCode.detect();
  if (!detect.installed) {
    throw new OpperError(
      "AGENT_NOT_FOUND",
      "VS Code's `code` CLI was not found on PATH",
      "Open VS Code → Cmd+Shift+P → 'Shell Command: Install code in PATH', then re-run.",
    );
  }

  // The setup function detects the missing extension and prompts the user
  // before installing — no extra orchestration needed here.
  const result = await configureGitHubCopilotVSCode({ channel: "stable" });
  console.log(
    brand.accent(`✓ Wrote Opper provider block to ${result.path}.`),
  );
  console.log("");
  console.log("Next steps in VS Code:");
  console.log("  1. Reload the window (Cmd+Shift+P → 'Developer: Reload Window')");
  console.log(
    "  2. Open Copilot Chat → click the model picker → 'Manage Models' → 'OAI Compatible'",
  );
  console.log("  3. Paste your OPPER_API_KEY when prompted");
  console.log("  4. Pick an Opper model and start chatting");
  console.log("");
  console.log(
    brand.dim(
      "Inline completions stay on GitHub's own service — BYOK only covers Chat and Agent mode.",
    ),
  );
}

export async function editorsGitHubCopilotVSCodeRemoveCommand(): Promise<void> {
  const result = await unconfigureGitHubCopilotVSCode({ channel: "stable" });
  if (result.removed) {
    console.log(
      brand.accent(`✓ Removed Opper provider from ${result.path}.`),
    );
  } else {
    console.log(
      brand.dim(`No Opper provider found in ${result.path}; nothing to remove.`),
    );
  }
}
