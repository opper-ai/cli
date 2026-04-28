#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import updateNotifier from "update-notifier";
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
import { addGroupedHelpText } from "./cli/help.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
) as { name: string; version: string };

// Once-a-day background check against npm. Notifies on the *next* run after
// a new version is found. Auto-skips in CI and honours NO_UPDATE_NOTIFIER /
// --no-update-notifier upstream.
updateNotifier({
  pkg: { name: pkg.name, version: pkg.version },
  updateCheckInterval: 1000 * 60 * 60 * 24,
}).notify({ defer: true });

const program = new Command();

program
  .name("opper")
  .description("The official Opper CLI")
  .version(pkg.version, "-v, --version")
  .option("--key <slot>", "API key slot to use", "default")
  .option("--debug", "enable debug output", false)
  .option("--no-telemetry", "disable anonymous telemetry")
  .option("--no-color", "disable ANSI colors")
  .action(async () => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      program.outputHelp();
      return;
    }
    await menuCommand({ key: program.opts().key, version: pkg.version });
  });

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

const ctx: CliContext = {
  key: () => program.opts().key as string,
  version: pkg.version,
};

const registrars: RegisterFn[] = [
  registerAuth,
  registerAsk,
  registerSkills,
  registerEditors,
  registerAgents,
  registerPlatform,
];
for (const register of registrars) register(program, ctx);

addGroupedHelpText(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  printError(err);
  const code = err instanceof OpperError ? EXIT_CODES[err.code] : 1;
  process.exit(code);
});
