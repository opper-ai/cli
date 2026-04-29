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
import type { OpperRouting } from "../agents/types.js";

export interface LaunchOptions {
  agent: string;
  key: string;
  model?: string;
  install?: boolean;
  passthrough?: string[];
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

  const startedAt = new Date();
  const code = await adapter.spawn(opts.passthrough ?? [], routing);
  const endedAt = new Date();

  // Best-effort session summary. Failures here shouldn't change the exit
  // code or block the user — usage rollup can lag a few seconds, and the
  // window-based filter picks up other concurrent slot activity, so this
  // is a vibe-check, not an audit.
  try {
    await printSessionSummary({
      key: opts.key,
      startedAt,
      endedAt,
      model: routing.model,
    });
  } catch {
    // Silent — we don't want a usage 5xx to dwarf the agent's actual exit.
  }

  return code;
}

interface SummaryOptions {
  key: string;
  startedAt: Date;
  endedAt: Date;
  model: string;
}

// Numeric fields come back from /v2/analytics/usage as strings (or null
// for empty buckets). Coerce defensively at the edge.
interface UsageRow {
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
    });
  } catch {
    rows = [];
  }

  let cost = 0;
  let count = 0;
  let tokens = 0;
  for (const r of rows) {
    cost += toNum(r.cost);
    count += toNum(r.count);
    tokens += toNum(r.total_tokens);
  }

  // Always print Duration / Model / Traces — those are knowable
  // immediately and useful as a "where to look next" pointer. Cost /
  // tokens / requests only appear when the platform's usage rollup has
  // already caught up; the rollup lag is several seconds, so short
  // sessions usually exit before any data is available.
  const lines: string[] = ["", brand.accent("Session summary")];
  lines.push(`  ${brand.dim("Duration".padEnd(10))}${formatDuration(durationMs)}`);
  lines.push(`  ${brand.dim("Model".padEnd(10))}${opts.model}`);
  if (count > 0 || tokens > 0) {
    lines.push(`  ${brand.dim("Requests".padEnd(10))}${count.toLocaleString()}`);
    lines.push(`  ${brand.dim("Tokens".padEnd(10))}${tokens.toLocaleString()}`);
    lines.push(`  ${brand.dim("Cost".padEnd(10))}$${cost.toFixed(4)}`);
  }
  lines.push(`  ${brand.dim("Traces".padEnd(10))}https://platform.opper.ai/traces`);
  if (count === 0 && tokens === 0) {
    lines.push(
      brand.dim("  (usage rollup lags ~30s — run `opper usage list` for cost / token totals)"),
    );
  }
  lines.push("");
  process.stderr.write(lines.join("\n") + "\n");
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}
