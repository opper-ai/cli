#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { OpperError, EXIT_CODES } from "./errors.js";
import { printError } from "./ui/print.js";
import { menuCommand } from "./commands/menu.js";
import type { CliContext, RegisterFn } from "./cli/types.js";
import registerAuth from "./cli/auth.js";
import registerSkills from "./cli/skills.js";
import registerEditors from "./cli/editors.js";
import registerAgents from "./cli/agents.js";
import registerPlatform from "./cli/platform.js";
import registerAsk from "./cli/ask.js";
import registerKeys from "./cli/keys.js";
import registerMcp from "./cli/mcp.js";
import registerProxy from "./cli/proxy.js";
import { addGroupedHelpText } from "./cli/help.js";
import { checkForUpdate } from "./util/update-check.js";
import { getDeployment, slotNameForSelection } from "./config/deployments.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
) as { name: string; version: string };

// Inline npm version check with a 1h cache. Awaited so the cache write and
// the `process.once('exit')` registration both happen before Commander gets
// a chance to `process.exit()` (which it does for `--version` / `--help`)
// and tear down the pending fetch. Worst case: ~1s once per hour on cache
// refresh; sub-ms on warm cache. Non-TTY / CI / NO_UPDATE_NOTIFIER short-
// circuit the check entirely. Ctrl+C / SIGTERM skip the notice (the `exit`
// event doesn't fire on signals) but a future run picks it up from cache.
await checkForUpdate({ name: pkg.name, version: pkg.version });

const program = new Command();

program
  .name("opper")
  .description("The official Opper CLI")
  .version(pkg.version, "-v, --version")
  .option("--key <slot>", "API key slot to use (defaults to the active slot)")
  .option("-d, --deployment <name>", "Opper deployment: main (AWS) or evroc (or OPPER_DEPLOYMENT)")
  .option("--project-uuid <uuid>", "explicit Opper project target (does not bind the API key)")
  .option("--debug", "enable debug output", false)
  .option("--no-telemetry", "disable anonymous telemetry")
  .option("--no-color", "disable ANSI colors")
  // Commander drops its implicit help command when the root has an action.
  .helpCommand(true)
  .action(async (_options: unknown, command: Command) => {
    // Commander hands an unmatched subcommand to this default action as an
    // operand. Without this check a script calling a removed or misspelled
    // command gets the help text and exit 0, and a terminal gets the menu.
    const [unknown] = command.args;
    if (unknown !== undefined) {
      throw new OpperError("INVALID_ARGUMENT", `Unknown command "${unknown}".`, "Run `opper --help` to see the commands.");
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      program.outputHelp();
      return;
    }
    await menuCommand({ key: activeKey, version: pkg.version, projectUuid: program.opts().projectUuid, ...(program.opts().key !== undefined ? { explicitKey: program.opts().key as string } : {}) });
  });

let activeKey = "default";
program.hook("preAction", async (_command, actionCommand) => {
  if (program.opts().deployment !== undefined) {
    process.env.OPPER_DEPLOYMENT = getDeployment(program.opts().deployment).name;
  }
  const name = actionCommand.name();
  const parent = actionCommand.parent?.name();
  const options = actionCommand.opts();
  // These actions either operate on explicit configuration arguments or use
  // no API credentials. Leave any necessary config reads to the action itself.
  const independent = name === "login" || parent === "config" || parent === "skills"
    || (parent === "keys" && name === "create")
    || (parent === "mcp" && name === "add")
    || name === "version" || name === "help"
    || (parent === "agents" && ["list", "remove"].includes(name))
    || (parent === "editors" && (name === "list"
      || (name === "opencode" && (options.removeLoginBridge || options.mcp))
      || (name === "github-copilot-vscode" && options.remove)))
    || (parent === "proxy" && ["status", "tag", "clear", "stop"].includes(name))
    || (name === "logout" && options.all)
    || (actionCommand === program && (!process.stdin.isTTY || !process.stdout.isTTY || actionCommand.args.length > 0));
  // Login and single-slot logout operate on saved credentials even when an
  // environment key is present. Runtime environment keys never read slots.
  const environmentCredential = process.env.OPPER_API_KEY && name !== "login" && name !== "logout";
  activeKey = independent || environmentCredential
    ? program.opts().key ?? "default"
    : await slotNameForSelection(program.opts().key);
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

const ctx: CliContext = {
  key: () => activeKey,
  projectUuid: () => program.opts().projectUuid as string | undefined,
  version: pkg.version,
};

const registrars: RegisterFn[] = [
  registerAuth,
  registerAsk,
  registerSkills,
  registerEditors,
  registerAgents,
  registerPlatform,
  registerKeys,
  registerMcp,
  registerProxy,
];
for (const register of registrars) register(program, ctx);

addGroupedHelpText(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  printError(err);
  const code = err instanceof OpperError ? EXIT_CODES[err.code] : 1;
  process.exit(code);
});
