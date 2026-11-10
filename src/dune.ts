#!/usr/bin/env node
import { launchDune } from "./sandbox/dune.js";
import { parseDuneArgs } from "./sandbox/dune-args.js";

try {
  const { command, options, mode } = parseDuneArgs(process.argv.slice(2));
  if (mode === "help") {
    console.log(`Usage: dune [options] [--] <command> [arguments...]

Run any executable inside an experimental SRT sandbox.
Dune options go BEFORE the command; all later arguments pass through unchanged.

  --allow-domain <host>  Permit a network host (repeatable)
  --env <NAME>           Pass a named environment variable (repeatable)
  --allow-write <path>   Permit writes to an existing directory (repeatable)
  -h, --help             Show this help

  dune claude                      Native Claude subscription profile
  dune opper launch pi             Opper login and model selection
  dune --allow-domain registry.npmjs.org npm test
  dune --env OPENAI_API_KEY python script.py
  dune observe                     Local activity dashboard
  dune -- observe                  Run an executable named observe

Generic commands get a temporary home and no network access unless allowed.
Project edits are live. Claude and Opper have scoped authentication defaults.`);
  } else if (mode === "observe") {
    const observerUrl = new URL(
      "../scripts/sandbox-observer/server.mjs",
      import.meta.url,
    ).href;
    const { startObserver } = await import(observerUrl);
    const { server, url, history } = await startObserver();
    console.log(
      `Dune observer: ${url}\n${history ? `History: ${history}\n` : ""}Stop with Ctrl+C.`,
    );
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => server.close());
  } else process.exitCode = await launchDune(command, options);
} catch (error) {
  process.stderr.write(
    `dune: ${error instanceof Error ? error.message : "Launch failed"}\n`,
  );
  process.exitCode = 1;
}
