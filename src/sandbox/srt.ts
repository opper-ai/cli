import type { ActivitySink } from "./activity.js";
import { constants } from "node:os";
import { spawn } from "node:child_process";
// Keep the optional dependency out of compile-time resolution on Node 20,
// where npm omits SRT because its engine requires Node 22.12 or later.
type FilesystemPath = string | { path: string; literal: true };
export interface SandboxRuntimeConfig {
  allowPty?: boolean;
  network: { allowedDomains: string[]; deniedDomains: string[] };
  filesystem: {
    allowWrite: FilesystemPath[];
    denyRead: FilesystemPath[];
    denyWrite: FilesystemPath[];
  };
}
interface SandboxLibrary {
  SandboxManager: {
    initialize(
      config: SandboxRuntimeConfig,
      ask?: (request: { host: string; port?: number }) => Promise<boolean>,
    ): Promise<void>;
    wrapWithSandbox(command: string, shell: string): Promise<string>;
    reset(): Promise<void>;
  };
}
import { OpperError } from "../errors.js";

export async function loadSrt() {
  try {
    const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 12))
      throw new Error("Unsupported Node version");
    const moduleName = "@anthropic-ai/sandbox-runtime";
    return (await import(moduleName)) as SandboxLibrary;
  } catch {
    throw new OpperError(
      "AGENT_NOT_FOUND",
      "The bundled SRT library could not load.",
      "Use Node >=22.12 and reinstall Opper with npm optional dependencies enabled. Linux also requires bubblewrap and socat.",
    );
  }
}

export function shellQuote(argument: string): string {
  return "'" + argument.replaceAll("'", "'\\''") + "'";
}

export async function runSrt(
  command: string[],
  config: SandboxRuntimeConfig,
  env: NodeJS.ProcessEnv,
  cwd: string,
  activity?: ActivitySink,
): Promise<number> {
  let manager: SandboxLibrary["SandboxManager"] | undefined;
  let pid: number | undefined;
  let interrupted: NodeJS.Signals | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        activity?.("ERROR", "Could not signal sandbox process group.");
    }
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
  const handlers = signals.map((signal) => {
    const handler = () => {
      interrupted ??= signal;
      signalGroup(signal);
      if (pid && signal !== "SIGINT" && !killTimer) {
        killTimer = setTimeout(() => signalGroup("SIGKILL"), 2000);
        killTimer.unref();
      }
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  const interruptedCode = () =>
    interrupted ? 128 + constants.signals[interrupted] : undefined;
  try {
    manager = (await loadSrt()).SandboxManager;
    if (interrupted) return interruptedCode()!;
    await manager.initialize(
      config,
      activity
        ? async ({ host, port }) => {
            activity("NETWORK", `${host}:${port ?? "unknown"} blocked`);
            return false;
          }
        : undefined,
    );
    if (interrupted) return interruptedCode()!;
    const wrapped = await manager.wrapWithSandbox(
      command.map(shellQuote).join(" "),
      "/bin/sh",
    );
    if (interrupted) return interruptedCode()!;
    // The in-process network proxies need a running Node event loop.
    return await new Promise<number>((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", wrapped], {
        cwd,
        env,
        stdio: "inherit",
        detached: true,
      });
      // Signal the worker, agent and ordinary subprocesses as one process group.
      pid = child.pid;
      child.once("error", reject);
      child.once("close", (code, signal: NodeJS.Signals | null) => {
        resolve(code ?? (signal ? 128 + constants.signals[signal] : 1));
      });
    });
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    if (killTimer) clearTimeout(killTimer);
    signalGroup("SIGKILL");
    await manager?.reset();
  }
}
