import { brand } from "../ui/colors.js";

export interface ModelUsage {
  model: string;
  cost: number;
  count: number;
  tokens: number;
}

export interface SessionSummaryOptions {
  durationMs: number;
  models: ModelUsage[];
  tracesUrl: string;
}

const LABEL_WIDTH = 10;

function label(text: string): string {
  return brand.dim(text.padEnd(LABEL_WIDTH));
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

export function formatSessionSummary(opts: SessionSummaryOptions): string {
  const lines: string[] = ["", brand.accent("Session summary")];
  lines.push(`  ${label("Duration")}${formatDuration(opts.durationMs)}`);

  if (opts.models.length === 0) {
    lines.push(`  ${label("Traces")}${opts.tracesUrl}`);
    lines.push(
      brand.dim(
        "  (usage rollup lags ~30s — run `opper usage list` for cost / token totals)",
      ),
    );
    lines.push("");
    return lines.join("\n") + "\n";
  }

  const sorted = [...opts.models].sort((a, b) => b.cost - a.cost);
  const totalCost = sorted.reduce((s, m) => s + m.cost, 0);
  const totalCount = sorted.reduce((s, m) => s + m.count, 0);
  const totalTokens = sorted.reduce((s, m) => s + m.tokens, 0);

  const [first] = sorted;
  if (sorted.length === 1 && first) {
    lines.push(`  ${label("Model")}${first.model}`);
    lines.push(`  ${label("Requests")}${first.count.toLocaleString()}`);
    lines.push(`  ${label("Tokens")}${first.tokens.toLocaleString()}`);
    lines.push(`  ${label("Cost")}$${first.cost.toFixed(4)}`);
  } else {
    // Pad model names so the per-model columns line up.
    const nameWidth = Math.max(...sorted.map((m) => m.model.length));
    const reqWidth = Math.max(
      ...sorted.map((m) => `${m.count.toLocaleString()} reqs`.length),
    );
    const tokWidth = Math.max(
      ...sorted.map((m) => `${m.tokens.toLocaleString()} tok`.length),
    );
    lines.push(`  ${label("Models")}`);
    for (const m of sorted) {
      const reqs = `${m.count.toLocaleString()} reqs`.padStart(reqWidth);
      const tok = `${m.tokens.toLocaleString()} tok`.padStart(tokWidth);
      const cost = `$${m.cost.toFixed(4)}`;
      lines.push(`    ${m.model.padEnd(nameWidth)}  ${reqs}  ${tok}  ${cost}`);
    }
    lines.push(`  ${label("Requests")}${totalCount.toLocaleString()}`);
    lines.push(`  ${label("Tokens")}${totalTokens.toLocaleString()}`);
    lines.push(`  ${label("Cost")}$${totalCost.toFixed(4)}`);
  }

  lines.push(`  ${label("Traces")}${opts.tracesUrl}`);
  lines.push("");
  return lines.join("\n") + "\n";
}
