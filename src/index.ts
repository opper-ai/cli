#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { OpperError, EXIT_CODES } from "./errors.js";
import { printError } from "./ui/print.js";
import { whoamiCommand } from "./commands/whoami.js";
import { loginCommand } from "./commands/login.js";

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

program.parseAsync(process.argv).catch((err: unknown) => {
  printError(err);
  const code = err instanceof OpperError ? EXIT_CODES[err.code] : 1;
  process.exit(code);
});
