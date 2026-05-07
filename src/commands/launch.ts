import { getAdapter } from "../agents/registry.js";
import { isLaunchable } from "../agents/types.js";
import { getSlot } from "../auth/config.js";
import { loginCommand } from "./login.js";
import { OpperError } from "../errors.js";
import { brand } from "../ui/colors.js";
import { OPPER_COMPAT_URL } from "../config/endpoints.js";
import { DEFAULT_MODELS } from "../config/models.js";
import { OpperApi } from "../api/client.js";
import { resolveApiContext } from "../api/resolve.js";
import type { OpperRouting, SpawnOptions } from "../agents/types.js";
import { formatSessionSummary, type ModelUsage } from "./launch-summary.js";

const TRACES_URL = "https://platform.opper.ai/traces";

export interface LaunchOptions {
  agent: string;
  key: string;
  model?: string;
  install?: boolean;
  passthrough?: string[];
  configScope?: SpawnOptions["configScope"];
}

export async function launchCommand(opts: LaunchOptions): Promise<number> {
  const adapter = getAdapter(opts.agent);
  if (!adapter) {
    throw new OpperError(
      "AGENT_NOT_FOUND",
      `Unknown agent "${opts.agent}"`,
      "Run `opper agents list` to see supported agents.",
    );
  }
  if (!isLaunchable(adapter)) {
    throw new OpperError(
      "AGENT_NOT_FOUND",
      `${adapter.displayName} is a configure-only integration and cannot be launched`,
      `Configure it via the agents menu (\`opper\` → Agents → ${adapter.displayName}).`,
    );
  }

  let slot = await getSlot(opts.key);
  if (!slot) {
    await loginCommand({ key: opts.key });
    slot = await getSlot(opts.key);
    if (!slot) {
      throw new OpperError(
        "AUTH_REQUIRED",
        `No API key stored for slot "${opts.key}"`,
        "Run `opper login` first.",
      );
    }
  }

  const detection = await adapter.detect();
  if (!detection.installed) {
    if (!opts.install) {
      throw new OpperError(
        "AGENT_NOT_FOUND",
        `${adapter.displayName} is not installed`,
        `Run \`opper launch ${adapter.name} --install\` to install it, or visit ${adapter.docsUrl}.`,
      );
    }
    if (!adapter.install) {
      throw new OpperError(
        "AGENT_NOT_FOUND",
        `${adapter.displayName} has no scripted installer`,
        `Install manually from ${adapter.docsUrl}.`,
      );
    }
    console.log(brand.dim(`Installing ${adapter.displayName}…`));
    await adapter.install();
  }

  const routing: OpperRouting = {
    baseUrl: OPPER_COMPAT_URL,
    apiKey: slot.apiKey,
    model: opts.model ?? DEFAULT_MODELS.opus,
    compatShape: "openai",
  };

  // The child agent shares our controlling terminal — Ctrl+C / hangup
  // signals get delivered to the whole foreground process group, us
  // included. Without these no-op handlers the parent dies before
  // reaching the session-summary code below.
  const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
  const noopHandlers = signals.map((sig) => {
    const h = (): void => {
      /* swallow */
    };
    process.on(sig, h);
    return [sig, h] as const;
  });

  const startedAt = new Date();
  let code: number;
  const spawnOpts: SpawnOptions = opts.configScope
    ? { configScope: opts.configScope }
    : {};
  try {
    code = await adapter.spawn(opts.passthrough ?? [], routing, spawnOpts);
  } finally {
    for (const [sig, h] of noopHandlers) process.off(sig, h);
  }
  const endedAt = new Date();

  // Best-effort session summary. Failures are silent — we never block or
  // change the agent's exit code on a summary error.
  try {
    await printSessionSummary({
      key: opts.key,
      startedAt,
      endedAt,
    });
  } catch {
    /* swallow */
  }

  return code;
}

interface SummaryOptions {
  key: string;
  startedAt: Date;
  endedAt: Date;
}

// Numeric fields come back from /v2/analytics/usage as strings (or null
// for empty buckets). Coerce defensively at the edge.
interface UsageRow {
  model?: string | null;
  cost?: string | number | null;
  count?: number | null;
  total_tokens?: string | number | null;
}

function toNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

async function printSessionSummary(opts: SummaryOptions): Promise<void> {
  const durationMs = Math.max(0, opts.endedAt.getTime() - opts.startedAt.getTime());
  // Skip the summary entirely for very short sessions — likely an
  // immediate exit / install error / user ctrl-c before any traffic.
  if (durationMs < 1500) return;

  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  let rows: UsageRow[] = [];
  try {
    rows = await api.get<UsageRow[]>("/v2/analytics/usage", {
      from_date: opts.startedAt.toISOString(),
      to_date: opts.endedAt.toISOString(),
      // Without granularity the endpoint returns daily buckets, which
      // would sweep up the entire day's spend instead of just this
      // session.
      granularity: "minute",
      fields: "total_tokens",
      // Group by model so the summary reflects every model the agent
      // actually called (e.g. /model picker switches, Haiku for compaction)
      // rather than just the launch-time default.
      group_by: "model",
    });
  } catch {
    rows = [];
  }

  // Same minute bucket can show up multiple times when other group_by keys
  // exist server-side; merge by model just in case.
  const byModel = new Map<string, ModelUsage>();
  for (const r of rows) {
    const name = (r.model ?? "").trim();
    if (!name) continue;
    const existing = byModel.get(name) ?? { model: name, cost: 0, count: 0, tokens: 0 };
    existing.cost += toNum(r.cost);
    existing.count += toNum(r.count);
    existing.tokens += toNum(r.total_tokens);
    byModel.set(name, existing);
  }

  process.stderr.write(
    formatSessionSummary({
      durationMs,
      models: Array.from(byModel.values()),
      tracesUrl: TRACES_URL,
    }),
  );
}
