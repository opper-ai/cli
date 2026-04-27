import { whoamiCommand } from "../commands/whoami.js";
import { loginCommand } from "../commands/login.js";
import { logoutCommand } from "../commands/logout.js";
import {
  configAddCommand,
  configListCommand,
  configGetCommand,
  configRemoveCommand,
} from "../commands/config.js";
import type { RegisterFn } from "./types.js";

const register: RegisterFn = (program, ctx) => {
  program
    .command("whoami")
    .description("Show the authenticated user for the active slot")
    .action(async () => {
      await whoamiCommand({ key: ctx.key() });
    });

  program
    .command("login")
    .description("Authenticate with Opper via the OAuth device flow")
    .option("--force", "re-authenticate even if a key is already stored")
    .option("--base-url <url>", "override the Opper API base URL")
    .action(async (cmdOpts: { force?: boolean; baseUrl?: string }) => {
      await loginCommand({
        key: ctx.key(),
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
        key: ctx.key(),
        all: cmdOpts.all ?? false,
        ...(cmdOpts.yes ? { yes: true } : {}),
      });
    });

  const config = program
    .command("config")
    .description("Manage stored API keys");

  config
    .command("add")
    .description("Manually store an API key for a slot")
    .argument("<name>", "slot name")
    .argument("<apiKey>", "Opper API key")
    .option("--base-url <url>", "custom Opper base URL for this slot")
    .action(async (name: string, apiKey: string, cmdOpts: { baseUrl?: string }) => {
      await configAddCommand({
        name,
        apiKey,
        ...(cmdOpts.baseUrl ? { baseUrl: cmdOpts.baseUrl } : {}),
      });
    });

  config
    .command("list")
    .description("List configured slots")
    .action(configListCommand);

  config
    .command("get")
    .description("Print the API key for a slot (raw, for scripts)")
    .argument("<name>", "slot name")
    .action(async (name: string) => {
      await configGetCommand({ name });
    });

  config
    .command("remove")
    .description("Delete a stored slot")
    .argument("<name>", "slot name")
    .action(async (name: string) => {
      await configRemoveCommand({ name });
    });
};

export default register;
