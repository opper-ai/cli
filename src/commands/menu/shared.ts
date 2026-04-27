import { select, text, confirm, isCancel, log } from "@clack/prompts";
import { listAdapters } from "../../agents/registry.js";
import { OpperError } from "../../errors.js";
import type { AgentAdapter } from "../../agents/types.js";

export interface MenuOptions {
  key: string;
  version?: string;
}

export interface AdapterStatus {
  adapter: AgentAdapter;
  installed: boolean;
  configured: boolean;
}

export async function probeAdapters(): Promise<AdapterStatus[]> {
  return Promise.all(
    listAdapters().map(async (adapter) => {
      let installed = false;
      let configured = false;
      try {
        installed = (await adapter.detect()).installed;
      } catch {
        /* leave false */
      }
      try {
        configured = await adapter.isConfigured();
      } catch {
        /* leave false */
      }
      return { adapter, installed, configured };
    }),
  );
}

export function reportError(err: unknown): void {
  if (err instanceof OpperError) {
    log.error(`[${err.code}] ${err.message}${err.hint ? ` — ${err.hint}` : ""}`);
  } else {
    log.error(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Show a select menu and return the chosen string, or `null` if the user
 * cancelled (esc/Ctrl-C) or picked an option whose value is `"back"`.
 *
 * Submenus call this once and treat null as "exit this menu loop".
 */
export async function pickMenuChoice<T extends string>(
  message: string,
  options: Array<{ value: T; label: string; hint?: string }>,
): Promise<T | null> {
  // Normalise — clack's `Option<T>` under `exactOptionalPropertyTypes`
  // rejects `hint: undefined` literally, so we omit the field when absent.
  // The union of two object shapes confuses TS narrowing; the cast is safe.
  const normalised = options.map((o) =>
    o.hint === undefined
      ? { value: o.value, label: o.label }
      : { value: o.value, label: o.label, hint: o.hint },
  ) as Array<{ value: T; label: string; hint: string } | { value: T; label: string }>;
  const result = (await select({
    message,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options: normalised as any,
  })) as T | symbol;
  if (isCancel(result)) return null;
  if (typeof result !== "string") return null;
  if (result === "back") return null;
  return result;
}

/** Cancellable text prompt that returns the trimmed value, or null on cancel. */
export async function ask(
  message: string,
  opts: { required?: boolean } = {},
): Promise<string | null> {
  const promptOpts = opts.required
    ? {
        message,
        validate: (v: string | undefined) =>
          v && v.trim().length > 0 ? undefined : "Required",
      }
    : { message };
  const value = await text(promptOpts);
  if (isCancel(value)) return null;
  return (value ?? "").trim() || null;
}

export async function askConfirm(message: string, initial = false): Promise<boolean> {
  const v = await confirm({ message, initialValue: initial });
  if (isCancel(v)) return false;
  return v === true;
}
