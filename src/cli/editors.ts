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
    .description("Configure OpenCode inference, or add the account MCP with --mcp")
    .option("--global", "write to ~/.config/opencode/opencode.json", true)
    .option("--local", "write to ./opencode.json in the current directory")
    .option("--overwrite", "replace an existing Opper provider if present")
    .option("--mcp", "add the Opper account MCP only; preserve inference settings")
    .option("--mcp-url <url>", "MCP endpoint override (requires --mcp; default https://api.opper.ai/mcp)")
    .option("--mcp-scopes <scopes>", "advanced: restrict available permissions to these space-separated OAuth scopes (requires --mcp)")
    .action(async (cmdOpts: { global?: boolean; local?: boolean; overwrite?: boolean; mcp?: boolean; mcpUrl?: string; mcpScopes?: string }) => {
      await editorsOpenCodeCommand({
        location: cmdOpts.local ? "local" : "global",
        overwrite: cmdOpts.overwrite ?? false,
        ...(cmdOpts.mcp ? { mcp: true } : {}),
        ...(cmdOpts.mcpUrl !== undefined ? { mcpUrl: cmdOpts.mcpUrl } : {}),
        ...(cmdOpts.mcpScopes !== undefined ? { mcpScopes: cmdOpts.mcpScopes } : {}),
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
