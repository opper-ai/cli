#!/usr/bin/env node
import { Command } from "commander";
import { launchDune } from "./sandbox/dune.js";

const program = new Command()
  .name("dune")
  .description(
    "Experimental local sandbox launcher with native agent authentication and activity logs.",
  )
  .enablePositionalOptions();
program
  .command("observe")
  .description(
    "Open a local read-only collector for sandbox activity (prints a private URL).",
  )
  .action(async () => {
    const observerUrl = new URL(
      "../scripts/sandbox-observer/server.mjs",
      import.meta.url,
    ).href;
    const { startObserver } = await import(observerUrl);
    const { server, url } = await startObserver();
    console.log(`Dune observer: ${url}\nStop with Ctrl+C.`);
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => server.close());
  });
program
  .command("claude")
  .description(
    "Run Claude Code with your Claude subscription in an SRT sandbox. Claude arguments follow the command.",
  )
  .option(
    "--allow-domain <host>",
    "allow another network host (repeatable; put before Claude arguments)",
    (value: string, previous: string[]) => [...previous, value],
    [],
  )
  .allowUnknownOption()
  .allowExcessArguments()
  .passThroughOptions()
  .action(async (_options, command: Command) => {
    process.exitCode = await launchDune(
      command.args,
      command.opts().allowDomain,
    );
  });
try {
  await program.parseAsync();
} catch (error) {
  process.stderr.write(
    `dune: ${error instanceof Error ? error.message : "Launch failed"}\n`,
  );
  process.exitCode = 1;
}
