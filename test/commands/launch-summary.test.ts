import { describe, it, expect, beforeAll, afterAll } from "vitest";

let originalNoColor: string | undefined;
beforeAll(() => {
  originalNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
});
afterAll(() => {
  if (originalNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalNoColor;
});

const { formatSessionSummary } = await import("../../src/commands/launch-summary.js");

const TRACES = "https://platform.opper.ai/traces";

describe("formatSessionSummary", () => {
  it("renders the lag fallback when no usage rows came back", () => {
    const out = formatSessionSummary({
      durationMs: 90_000,
      models: [],
      tracesUrl: TRACES,
    });
    expect(out).toContain("Session summary");
    expect(out).toContain("Duration  1m 30s");
    expect(out).toContain("Traces    " + TRACES);
    expect(out).toContain("usage rollup lags");
    // No misleading "Model" line when we don't actually know what ran.
    expect(out).not.toMatch(/^\s*Model\s/m);
  });

  it("renders a single-model session with totals", () => {
    const out = formatSessionSummary({
      durationMs: 150_000,
      models: [
        { model: "claude-opus-4-7", cost: 0.1234, count: 10, tokens: 12_345 },
      ],
      tracesUrl: TRACES,
    });
    expect(out).toContain("Duration  2m 30s");
    expect(out).toContain("Model     claude-opus-4-7");
    expect(out).toContain("Requests  10");
    expect(out).toContain("Tokens    12,345");
    expect(out).toContain("Cost      $0.1234");
    expect(out).not.toContain("Models");
    expect(out).not.toContain("usage rollup lags");
  });

  it("renders a per-model breakdown when more than one model was used", () => {
    const out = formatSessionSummary({
      durationMs: 60_000,
      models: [
        { model: "claude-opus-4-7", cost: 0.1, count: 8, tokens: 10_000 },
        { model: "claude-haiku-4-5", cost: 0.0234, count: 2, tokens: 2_345 },
      ],
      tracesUrl: TRACES,
    });
    expect(out).toContain("Models");
    // Per-model lines list the model name plus its own usage.
    expect(out).toMatch(/claude-opus-4-7\s+8 reqs\s+10,000 tok\s+\$0\.1000/);
    expect(out).toMatch(/claude-haiku-4-5\s+2 reqs\s+2,345 tok\s+\$0\.0234/);
    // Aggregated totals still appear.
    expect(out).toContain("Tokens    12,345");
    expect(out).toContain("Cost      $0.1234");
    // The single-model "Model" line should not appear in multi-model layout.
    expect(out).not.toMatch(/^\s{2}Model\s/m);
  });

  it("sorts per-model rows by cost descending so the dominant model is first", () => {
    const out = formatSessionSummary({
      durationMs: 60_000,
      models: [
        { model: "cheap", cost: 0.001, count: 1, tokens: 100 },
        { model: "dominant", cost: 1.0, count: 5, tokens: 50_000 },
        { model: "middle", cost: 0.05, count: 2, tokens: 5_000 },
      ],
      tracesUrl: TRACES,
    });
    const dominantIdx = out.indexOf("dominant");
    const middleIdx = out.indexOf("middle");
    const cheapIdx = out.indexOf("cheap");
    expect(dominantIdx).toBeGreaterThan(-1);
    expect(dominantIdx).toBeLessThan(middleIdx);
    expect(middleIdx).toBeLessThan(cheapIdx);
  });

  it("formats short durations in seconds and longer ones in hours", () => {
    expect(
      formatSessionSummary({ durationMs: 5_000, models: [], tracesUrl: TRACES }),
    ).toContain("Duration  5s");
    expect(
      formatSessionSummary({
        durationMs: 60 * 60 * 1000 + 5 * 60 * 1000,
        models: [],
        tracesUrl: TRACES,
      }),
    ).toContain("Duration  1h 5m");
  });
});
