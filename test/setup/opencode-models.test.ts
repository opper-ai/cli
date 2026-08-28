import { describe, it, expect } from "vitest";
import {
  toOpenCodeModels,
  displayName,
  type CompatModel,
} from "../../src/setup/opencode-models.js";

/** A priced, tool-capable chat entry — the shape most catalogue rows have. */
function model(over: Partial<CompatModel> = {}): CompatModel {
  return {
    id: "anthropic/claude-sonnet-5",
    context_length: 1_000_000,
    pricing: { prompt: "0.000002", completion: "0.00001" },
    opper: { kind: "model", type: "llm", capabilities: ["text", "tools"], max_output_tokens: 64_000 },
    ...over,
  };
}

describe("toOpenCodeModels", () => {
  it("converts per-token prices to per-million", () => {
    const m = toOpenCodeModels([model()])["anthropic/claude-sonnet-5"]!;
    expect(m.cost.input).toBe(2);
    expect(m.cost.output).toBe(10);
  });

  it("rounds away the float noise that scaling by a million introduces", () => {
    // 0.0000002 * 1e6 is 0.19999999999999998 in binary floating point, and
    // OpenCode prints the number verbatim.
    const m = toOpenCodeModels([
      model({ pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000002" } }),
    ])["anthropic/claude-sonnet-5"]!;
    expect(m.cost.cache_read).toBe(0.2);
  });

  it("keeps a genuinely free model rather than reading 0 as missing", () => {
    const m = toOpenCodeModels([model({ pricing: { prompt: "0", completion: "0" } })]);
    expect(m["anthropic/claude-sonnet-5"]?.cost).toEqual({ input: 0, output: 0 });
  });

  it("skips a chat model with no price, so cost is never silently zero", () => {
    expect(toOpenCodeModels([model({ pricing: {} })])).toEqual({});
    expect(toOpenCodeModels([model({ pricing: { prompt: "0.000002" } })])).toEqual({});
  });

  it("skips non-chat rows", () => {
    const embedding = model({ id: "openai/text-embedding-3", opper: { kind: "model", type: "embedding" } });
    expect(toOpenCodeModels([embedding])).toEqual({});
  });

  it("maps capabilities onto the flags OpenCode trusts", () => {
    const caps = ["text", "tools", "reasoning", "vision", "pdf"];
    const m = toOpenCodeModels([model({ opper: { kind: "model", type: "llm", capabilities: caps } })])[
      "anthropic/claude-sonnet-5"
    ]!;
    expect(m.tool_call).toBe(true);
    expect(m.reasoning).toBe(true);
    expect(m.attachment).toBe(true);
    expect(m.modalities?.input).toEqual(["text", "image", "pdf"]);
  });

  it("does not claim tool calling for a model without it", () => {
    const m = toOpenCodeModels([model({ opper: { kind: "model", type: "llm", capabilities: ["text"] } })])[
      "anthropic/claude-sonnet-5"
    ]!;
    expect(m.tool_call).toBe(false);
    expect(m.attachment).toBe(false);
  });

  it("falls back to modest limits when the gateway reports none", () => {
    const m = toOpenCodeModels([model({ context_length: undefined, opper: { kind: "model", type: "llm" } })])[
      "anthropic/claude-sonnet-5"
    ]!;
    expect(m.limit).toEqual({ context: 128_000, output: 8_192 });
  });

  it("includes a dynamic route, which carries no price, context or capabilities", () => {
    // Dropping these on the price gate would lose the one thing a static
    // model list can never carry.
    const route: CompatModel = { id: "dynamic/test-custom-route", opper: { kind: "dynamic_route" } };
    const m = toOpenCodeModels([route])["dynamic/test-custom-route"];
    expect(m).toBeDefined();
    expect(m!.cost).toEqual({ input: 0, output: 0 });
    expect(m!.tool_call).toBe(true);
    expect(m!.limit.context).toBe(128_000);
  });

  it("keeps pools, which are ordinary priced entries under a bare name", () => {
    const pool = model({ id: "claude-sonnet-5", opper: { kind: "pool", type: "llm", capabilities: ["tools"] } });
    expect(Object.keys(toOpenCodeModels([pool]))).toEqual(["claude-sonnet-5"]);
  });
});

describe("displayName", () => {
  it("drops the maker prefix", () => {
    expect(displayName("anthropic/claude-sonnet-5")).toBe("Claude Sonnet 5");
  });

  it("labels a route so it cannot be mistaken for a model of the same name", () => {
    expect(displayName("dynamic/test-custom-route")).toBe("Test Custom Route (route)");
  });

  it("keeps a bare pool name intact", () => {
    expect(displayName("claude-sonnet-5")).toBe("Claude Sonnet 5");
  });
});
