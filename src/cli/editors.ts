import {
  editorsListCommand,
  editorsOpenCodeCommand,
  editorsGitHubCopilotVSCodeCommand,
  editorsGitHubCopilotVSCodeRemoveCommand,
} from "../commands/editors.js";
import type { RegisterFn } from "./types.js";

const register: RegisterFn = (program) => {
  const editors = program
    .command("editors")
    .description("Configure Opper in supported AI code editors");

  editors
    .command("list")
    .description("List supported editors")
    .action(editorsListCommand);

  editors
    .command("opencode")
    .description("Write the Opper provider block into OpenCode's config")
    .option("--global", "write to ~/.config/opencode/opencode.json", true)
    .option("--local", "write to ./opencode.json in the current directory")
    .option("--overwrite", "replace an existing Opper provider if present")
    .action(async (cmdOpts: { global?: boolean; local?: boolean; overwrite?: boolean }) => {
      await editorsOpenCodeCommand({
        location: cmdOpts.local ? "local" : "global",
        overwrite: cmdOpts.overwrite ?? false,
      });
    });

  editors
    .command("github-copilot-vscode")
    .description(
      "Route VS Code Copilot Chat through Opper via the OAI Compatible community extension",
    )
    .option("--remove", "remove the Opper provider from VS Code settings")
    .action(async (cmdOpts: { remove?: boolean }) => {
      if (cmdOpts.remove) {
        await editorsGitHubCopilotVSCodeRemoveCommand();
        return;
      }
      await editorsGitHubCopilotVSCodeCommand();
    });
};

export default register;
