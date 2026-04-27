import type { Command } from "commander";

/**
 * Each per-domain registration file under `src/cli/` exports a default
 * function with this shape:
 *
 *     export default function register(program: Command, ctx: CliContext) {
 *       program.command("…").action(…)
 *     }
 *
 * `src/index.ts` walks a list of these and calls each. New command groups
 * get added by creating one new file under `src/cli/` and importing it.
 */
export interface CliContext {
  /** Resolves the active `--key` slot at action time (commander parses
   *  global options after subcommand parse, so we can't capture it
   *  eagerly). */
  key(): string;
  version: string;
}

export type RegisterFn = (program: Command, ctx: CliContext) => void;
