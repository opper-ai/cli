import {
  editorsListCommand,
  editorsOpenCodeCommand,
  editorsContinueCommand,
} from "../commands/editors.js";
import type { RegisterFn } from "./types.js";

const register: RegisterFn = (program, ctx) => {
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
    .command("continue")
    .description("Write Opper models into Continue.dev's config")
    .option("--global", "write to ~/.continue/config.yaml", true)
    .option("--local", "write to ./.continue/config.yaml")
    .option("--overwrite", "replace existing Opper models if present")
    .action(async (cmdOpts: { global?: boolean; local?: boolean; overwrite?: boolean }) => {
      await editorsContinueCommand({
        location: cmdOpts.local ? "local" : "global",
        overwrite: cmdOpts.overwrite ?? false,
        key: ctx.key(),
      });
    });
};

export default register;
