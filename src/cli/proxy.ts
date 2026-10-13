import { InvalidArgumentError, type Command } from "commander";
import { desktopStartCommand, desktopTagCommand, desktopStatusCommand, desktopClearCommand, desktopOpenCommand, desktopStopCommand } from "../commands/desktop.js";
import { collectTagPairs } from "./agents.js";
import type { RegisterFn } from "./types.js";

const register: RegisterFn = (program, ctx) => {
  const proxy = program.command("proxy").description("Manage the local inference proxy and open its session picker")
    .option("--state-dir <path>", "private directory for this bridge's state")
    .option("--no-open", "print a one-use picker link without opening a browser")
    .action(async (opts: {stateDir?: string; open?: boolean}, cmd: Command) => {
      opts = cmd.optsWithGlobals();
      await desktopOpenCommand({ key: ctx.key(), open: opts.open !== false,
        ...(opts.stateDir !== undefined ? {stateDir: opts.stateDir} : {}),
        ...(ctx.projectUuid?.() !== undefined ? {projectUuid: ctx.projectUuid()} : {}),
      });
    });
  proxy.command("open")
    .description("Open the picker; start a local background bridge if needed")
    .option("--state-dir <path>", "private directory for this bridge's state")
    .option("--no-open", "print a one-use picker link without opening a browser")
    .action(async (opts: {stateDir?: string; open?: boolean}, cmd: Command) => {
      opts = cmd.optsWithGlobals();
      await desktopOpenCommand({ key: ctx.key(), open: opts.open !== false,
        ...(opts.stateDir !== undefined ? {stateDir: opts.stateDir} : {}),
        ...(ctx.projectUuid?.() !== undefined ? {projectUuid: ctx.projectUuid()} : {}),
      });
    });
  proxy.command("start")
    .description("Start the bridge in the foreground (Ctrl-C stops it)")
    .option("--state-dir <path>", "private directory for this bridge's runtime state")
    .option("--port <port>", "loopback listening port (0 chooses a free port)", (value: string) => {
      if (!/^\d+$/.test(value) || Number(value) > 65535) throw new InvalidArgumentError("port must be an integer from 0 to 65535");
      return Number(value);
    }, 0)
    .option("--tag <pair>", "initial key=value attribution tag (repeatable)", collectTagPairs, {} as Record<string, string>)
    .action(async (opts: { stateDir?: string; port: number; tag: Record<string, string> }, cmd: Command) => {
      opts = cmd.optsWithGlobals();
      await desktopStartCommand({ key: ctx.key(), port: opts.port, tags: opts.tag,
        ...(opts.stateDir !== undefined ? { stateDir: opts.stateDir } : {}),
        ...(ctx.projectUuid?.() !== undefined ? { projectUuid: ctx.projectUuid() } : {}),
      });
    });
  proxy.command("tag")
    .description("Replace tags for all subsequent requests; running streams keep their original tags")
    .option("--state-dir <path>", "runtime state directory of the running bridge")
    .requiredOption("--tag <pair>", "new key=value attribution tag (repeatable)", (raw: string, tags: Record<string, string> | undefined) => collectTagPairs(raw, tags ?? {}))
    .action(async (opts: { stateDir?: string; tag: Record<string, string> }, cmd: Command) => {
      opts = cmd.optsWithGlobals();
      await desktopTagCommand({ tags: opts.tag, ...(opts.stateDir !== undefined ? { stateDir: opts.stateDir } : {}) });
    });
  proxy.command("status")
    .description("Show the active tags, session and local endpoint (no credentials)")
    .option("--state-dir <path>", "runtime state directory of the running bridge")
    .action(async (opts: { stateDir?: string }, cmd: Command) => {
      opts = cmd.optsWithGlobals();
      await desktopStatusCommand(opts.stateDir !== undefined ? { stateDir: opts.stateDir } : {});
    });
  proxy.command("clear")
    .description("End the active session and pause new inference until a session is selected")
    .option("--state-dir <path>", "runtime state directory of the running bridge")
    .action(async (opts: { stateDir?: string }, cmd: Command) => {
      opts = cmd.optsWithGlobals();
      await desktopClearCommand(opts.stateDir !== undefined ? { stateDir: opts.stateDir } : {});
    });
  proxy.command("stop")
    .description("Stop the local bridge service; keep saved sessions and connection settings")
    .option("--state-dir <path>", "runtime state directory of the running bridge")
    .action(async (opts: {stateDir?: string}, cmd: Command) => {
      opts = cmd.optsWithGlobals();
      await desktopStopCommand(opts.stateDir !== undefined ? {stateDir: opts.stateDir} : {});
    });
};
export default register;
