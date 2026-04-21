#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { OpperError, EXIT_CODES } from "./errors.js";
import { printError } from "./ui/print.js";
import { whoamiCommand } from "./commands/whoami.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import {
  skillsInstallCommand,
  skillsUpdateCommand,
  skillsListCommand,
} from "./commands/skills.js";
import {
  editorsListCommand,
  editorsOpenCodeCommand,
  editorsContinueCommand,
} from "./commands/editors.js";
import { setupCommand } from "./commands/setup.js";
import { agentsListCommand } from "./commands/agents.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
) as { version: string };

const program = new Command();

program
  .name("opper")
  .description("The official Opper CLI")
  .version(pkg.version, "-v, --version")
  .option("--key <slot>", "API key slot to use", "default")
  .option("--debug", "enable debug output", false)
  .option("--no-telemetry", "disable anonymous telemetry")
  .option("--no-color", "disable ANSI colors");

program.hook("preAction", () => {
  if (program.opts().color === false) {
    process.env.NO_COLOR = "1";
  }
});

program
  .command("version")
  .description("Print the CLI version")
  .action(() => {
    console.log(pkg.version);
  });

program
  .command("whoami")
  .description("Show the authenticated user for the active slot")
  .action(async () => {
    await whoamiCommand({ key: program.opts().key });
  });

program
  .command("login")
  .description("Authenticate with Opper via the OAuth device flow")
  .option("--force", "re-authenticate even if a key is already stored")
  .option("--base-url <url>", "override the Opper API base URL")
  .action(async (cmdOpts: { force?: boolean; baseUrl?: string }) => {
    await loginCommand({
      key: program.opts().key,
      ...(cmdOpts.baseUrl ? { baseUrl: cmdOpts.baseUrl } : {}),
      ...(cmdOpts.force ? { force: true } : {}),
    });
  });

program
  .command("logout")
  .description("Clear stored Opper credentials for a slot")
  .option("--all", "clear every slot", false)
  .option("--yes", "skip confirmation for --all", false)
  .action(async (cmdOpts: { all?: boolean; yes?: boolean }) => {
    await logoutCommand({
      key: program.opts().key,
      all: cmdOpts.all ?? false,
      ...(cmdOpts.yes ? { yes: true } : {}),
    });
  });

const skills = program.command("skills").description("Manage Opper skills");

skills
  .command("install")
  .description("Install Opper skills via `npx skills add opper-ai/opper-skills`")
  .action(skillsInstallCommand);

skills
  .command("update")
  .description("Update Opper skills to the latest version")
  .action(skillsUpdateCommand);

skills
  .command("list")
  .description("Show whether Opper skills are installed")
  .action(skillsListCommand);

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
      key: program.opts().key,
    });
  });

program
  .command("setup")
  .description("Run the interactive setup wizard")
  .action(async () => {
    await setupCommand({ key: program.opts().key });
  });

const agentsCmd = program
  .command("agents")
  .description("Manage supported AI agents");

agentsCmd
  .command("list")
  .description("List supported agents and whether each is installed")
  .action(agentsListCommand);

program.parseAsync(process.argv).catch((err: unknown) => {
  printError(err);
  const code = err instanceof OpperError ? EXIT_CODES[err.code] : 1;
  process.exit(code);
});
