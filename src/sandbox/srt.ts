import {
  readPolicy,
  applyPolicy,
} from "../../scripts/sandbox-policy/policy.mjs";
import type { ActivitySink } from "./activity.js";
import { constants } from "node:os";
import { spawn } from "node:child_process";
import { watchProcesses } from "./processes.js";
// Keep the optional dependency out of compile-time resolution on Node 20,
// where npm omits SRT because its engine requires Node 22.12 or later.
type FilesystemPath = string | { path: string; literal: true };
export interface SandboxRuntimeConfig {
  allowPty?: boolean;
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    tlsTerminate?: Record<string, never>;
    filterRequest?: (
      request: Request,
      info?: { scheme?: "http" | "https" },
    ) => Promise<{ action: "allow" }>;
  };
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
      enableLogMonitor?: boolean,
    ): Promise<void>;
    wrapWithSandbox(command: string, shell: string): Promise<string>;
    updateConfig(config: SandboxRuntimeConfig): void;
    getSandboxViolationStore?(): {
      subscribe(listener: (violations: { line: string }[]) => void): () => void;
    };
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

export interface NetworkObservation {
  /**
   * Let every host through unless a deny rule blocks it, logging each
   * connection. The allowlist is emptied so SRT asks about every host.
   */
  allowAll?: boolean;
  /**
   * Terminate TLS in the proxy and log each request's method and URL without
   * its query string. Headers and bodies are never read.
   */
  urls?: boolean;
}

/**
 * SRT's own rule: exact host, or `*.example.com` for strict subdomains. An
 * entry may end in `:port` to match that port only.
 */
export function matchesDomain(
  host: string,
  pattern: string,
  port?: number,
): boolean {
  const name = host.toLowerCase();
  let rule = pattern.toLowerCase();
  const ported = /^([^:]+):(\d+)$/.exec(rule);
  if (ported) {
    if (Number(ported[2]) !== port) return false;
    rule = ported[1]!;
  }
  if (!rule.startsWith("*.")) return name === rule;
  // Never suffix-match an address: `1.2.3.4%x.example.com` is not a subdomain.
  return !/[:%]/.test(name) && name.endsWith(rule.slice(1));
}

export async function runSrt(
  command: string[],
  config: SandboxRuntimeConfig,
  env: NodeJS.ProcessEnv,
  cwd: string,
  activity?: ActivitySink,
  policyPath?: string,
  observe: NetworkObservation = {},
): Promise<number> {
  let manager: SandboxLibrary["SandboxManager"] | undefined;
  let policyTimer: ReturnType<typeof setInterval> | undefined;
  let pid: number | undefined;
  let stopProcesses: (() => void) | undefined;
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
    let applied = policyPath ? readPolicy(policyPath) : undefined;
    const base: SandboxRuntimeConfig = observe.urls
      ? {
          ...config,
          network: {
            ...config.network,
            tlsTerminate: {},
            filterRequest: async (request, info) => {
              try {
                const url = new URL(request.url);
                activity?.(
                  "REQUEST",
                  `${request.method} ${info?.scheme ?? url.protocol.slice(0, -1)}://${url.host}${url.pathname}`.slice(
                    0,
                    400,
                  ),
                );
              } catch {
                /* Logging must never decide a request. */
              }
              return { action: "allow" };
            },
          },
        }
      : config;
    // SRT lets a host on its allowlist through without telling anyone. To log
    // every connection, the list is kept here instead and SRT is handed an
    // empty one, so each host that no deny rule stops reaches the callback.
    const decideHere = Boolean(activity) || observe.allowAll === true;
    let allowed: string[] = [];
    const withPolicy = (policy: typeof applied): SandboxRuntimeConfig => {
      if (!decideHere) {
        if (!policy) return base;
        return {
          ...base,
          network: { ...base.network, ...applyPolicy(base.network, policy) },
        };
      }
      const network = policy ? applyPolicy(base.network, policy) : base.network;
      allowed = network.allowedDomains;
      return {
        ...base,
        network: { ...base.network, ...network, allowedDomains: [] },
      };
    };
    await manager.initialize(
      withPolicy(applied),
      decideHere
        ? async ({ host, port }) => {
            const pass =
              observe.allowAll === true ||
              allowed.some((pattern) => matchesDomain(host, pattern, port));
            activity?.(
              "NETWORK",
              `${host}:${port ?? "unknown"} ${pass ? "allowed" : "blocked"}`,
            );
            return pass;
          }
        : undefined,
      // Report refused file access; on macOS this reads the system log.
      Boolean(activity),
    );
    if (activity) {
      // A host on the deny list never reaches the callback above; SRT reports
      // the refusal as a violation instead, in the spelling the client used.
      const reported = new WeakSet<object>();
      const refused = new Set<string>();
      manager.getSandboxViolationStore?.()?.subscribe((violations) => {
        for (const violation of violations) {
          if (reported.has(violation)) continue;
          reported.add(violation);
          // macOS: `cat(123) deny(1) file-read-data /path`. Linux reports
          // refused writes only: `deny openat /path`.
          const file =
            /\bdeny(?:\(\d+\))? file-(read|write)\S* (\/.*)$/.exec(
              violation.line,
            ) ?? /^deny (?!network-outbound )(\S+) (\/.*)$/.exec(violation.line);
          if (file) {
            const text = `${file[1] === "read" ? "read" : "write"} blocked ${file[2]}`;
            // A retry loop would otherwise fill the log with one path.
            if (refused.size < 5000 && !refused.has(text)) {
              refused.add(text);
              activity("FILE", text);
            }
            continue;
          }
          const host =
            /^deny network-outbound (\S+) \(host is on the deny list\)$/.exec(
              violation.line,
            )?.[1];
          if (host)
            activity(
              "NETWORK",
              `${host.toLowerCase().replace(/\.(?=:\d+$|$)/, "")} blocked`,
            );
        }
      });
    }
    if (interrupted) return interruptedCode()!;
    const wrapped = await manager.wrapWithSandbox(
      command.map(shellQuote).join(" "),
      "/bin/sh",
    );
    if (interrupted) return interruptedCode()!;
    if (policyPath && applied) {
      activity?.("POLICY", String(applied.version));
      policyTimer = setInterval(() => {
        try {
          const next = readPolicy(policyPath);
          if (
            next.version === applied!.version &&
            JSON.stringify(next.rules) !== JSON.stringify(applied!.rules)
          )
            throw new Error("Policy version was modified");
          if (next.version < applied!.version)
            throw new Error("Policy rollback");
          if (next.version !== applied!.version) {
            manager!.updateConfig(withPolicy(next));
            applied = next;
          }
          activity?.("POLICY", String(applied!.version));
        } catch {
          activity?.(
            "POLICYERROR",
            "Policy could not be applied; stopping sandbox.",
          );
          signalGroup("SIGKILL");
        }
      }, 1000);
      policyTimer.unref();
    }
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
      if (pid && activity) stopProcesses = watchProcesses(pid, activity);
      child.once("error", reject);
      child.once("close", (code, signal: NodeJS.Signals | null) => {
        resolve(code ?? (signal ? 128 + constants.signals[signal] : 1));
      });
    });
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    if (killTimer) clearTimeout(killTimer);
    if (policyTimer) clearInterval(policyTimer);
    stopProcesses?.();
    signalGroup("SIGKILL");
    await manager?.reset();
  }
}
