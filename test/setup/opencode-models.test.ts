import { describe, it, expect, vi, afterEach } from "vitest";
import {
  toOpenCodeModels,
  preserveOpenCodeVariants,
  displayName,
  pickerDisplayName,
  type CompatModel,
  fetchOpenCodeModels,
  resolveOpenCodeModels,
} from "../../src/setup/opencode-models.js";
import { OpperApi } from "../../src/api/client.js";
import { useTempOpperHome } from "../helpers/temp-home.js";

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
  it("maps the complete advertised effort set and validated default", () => {
    const m = toOpenCodeModels([model({ id: "gpt-6.1-sol", opper: {
      kind: "pool", type: "llm", capabilities: ["tools", "reasoning"],
      reasoning: { supported: ["low", "medium", "high", "xhigh", "max"], default: "medium" },
    } })])["gpt-6.1-sol"]!;
    expect(m.options).toEqual({ reasoningEffort: "medium" });
    expect(m.variants).toEqual({
      none: { disabled: true, opperManagedDisabled: true }, minimal: { disabled: true, opperManagedDisabled: true },
      thinking: { disabled: true, opperManagedDisabled: true },
      low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" }, xhigh: { reasoningEffort: "xhigh" }, max: { reasoningEffort: "max" },
    });
  });

  it.each([undefined, { supported: [] }, { supported: ["invented"], default: "invented" }])(
    "does not infer selectable effort from capabilities without known metadata: %j", (reasoning) => {
      const m = toOpenCodeModels([model({ opper: { capabilities: ["reasoning"], reasoning } })])["anthropic/claude-sonnet-5"]!;
      expect(m.options).toBeUndefined();
      expect(Object.values(m.variants!)).toEqual(Array(8).fill({ disabled: true, opperManagedDisabled: true }));
    },
  );

  it("uses only a pool's advertised intersection and ignores an invalid default", () => {
    const m = toOpenCodeModels([model({ id: "mixed-pool", opper: {
      kind: "pool", reasoning: { supported: ["high"], default: "max" },
    } })])["mixed-pool"]!;
    expect(m.variants!.high).toEqual({ reasoningEffort: "high" });
    expect(m.variants!.max).toMatchObject({ disabled: true });
    expect(m.options).toBeUndefined();
  });

  it("does not assign efforts to dynamic routes even if metadata is present", () => {
    const m = toOpenCodeModels([{ id: "dynamic/unknown", opper: {
      kind: "dynamic_route", reasoning: { supported: ["max"], default: "max" },
    } }])["dynamic/unknown"]!;
    expect(m.options).toBeUndefined();
    expect(Object.values(m.variants!)).toEqual(Array(8).fill({ disabled: true, opperManagedDisabled: true }));
  });

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

  it("uses a route's reported bounds when the gateway resolves all candidates", () => {
    const route: CompatModel = {
      id: "dynamic/bounded",
      context_length: 200_000,
      opper: { kind: "dynamic_route", max_output_tokens: 32_000 },
    };
    expect(toOpenCodeModels([route])["dynamic/bounded"]!.limit).toEqual({
      context: 200_000,
      output: 32_000,
    });
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

describe("authenticated catalog discovery", () => {
  useTempOpperHome();
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  const context = { apiKey: "op_selected", baseUrl: "https://selected.example/gateway" };

  it("uses an explicit API context instead of ambient credentials", async () => {
    vi.stubEnv("OPPER_API_KEY", "op_unrelated");
    vi.stubEnv("OPPER_BASE_URL", "https://unrelated.example");
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [model()] })));
    vi.stubGlobal("fetch", fetch);
    const result = await resolveOpenCodeModels(context);
    expect(Object.keys(result!)).toEqual(["anthropic/claude-sonnet-5"]);
    expect(fetch).toHaveBeenCalledWith("https://selected.example/gateway/v3/compat/models", {
      method: "GET", headers: { Authorization: "Bearer op_selected" },
    });
  });

  it.each([{ data: [] }, { data: [model({ opper: { type: "embedding" } })] }])("keeps a successful empty usable catalog empty: %j", async ({ data }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data }))));
    expect(await fetchOpenCodeModels(new OpperApi(context))).toEqual({});
  });

  it.each([401, 503])("reports HTTP %s instead of substituting bundled models", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status })));
    await expect(fetchOpenCodeModels(new OpperApi(context))).rejects.toThrow();
  });

  it("reports a failed request instead of substituting bundled models", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(fetchOpenCodeModels(new OpperApi(context))).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("rejects a malformed catalog without treating it as an empty allowed list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [] }))));
    await expect(fetchOpenCodeModels(new OpperApi(context))).rejects.toThrow(/catalog/i);
  });
});

it("distinguishes deployments with identical names and separates pools and routes", () => {
 const ids=["provider-a/maker/GLM-5.3","provider-b/maker/GLM-5.3","glm-5.3","dynamic/glm-5.3"];
 expect(new Set(ids.map(pickerDisplayName)).size).toBe(ids.length);
 expect(pickerDisplayName(ids[0]!)).toContain(ids[0]);
});


describe("catalog effort refresh policy", () => {
  const fresh = () => toOpenCodeModels([model({ id: "allowed", opper: {
    kind: "pool", reasoning: { supported: ["high", "max"], default: "high" },
  } })]);
  it("suppresses inferred thinking without inventing a request default", () => {
    const mapped = toOpenCodeModels([model({ id: "fireworks/minimax-m3" }), model({ id: "openai/gpt-5.4" })]);
    expect(mapped["fireworks/minimax-m3"]!.variants!.thinking).toMatchObject({ disabled: true });
    expect(mapped["openai/gpt-5.4"]!.options).toBeUndefined();
  });
  it("preserves explicit user-disabled levels, compatible options and custom settings", () => {
    const mapped = preserveOpenCodeVariants(fresh(), { allowed: {
      options: { reasoningEffort: "max", textVerbosity: "low" },
      variants: { high: { disabled: true }, personal: { reasoningEffort: "max", temperature: 0 } },
    } });
    expect(mapped.allowed).toMatchObject({ options: { reasoningEffort: "max", textVerbosity: "low" },
      variants: { high: { disabled: true }, personal: { reasoningEffort: "max", temperature: 0 } } });
  });
  it("disables a custom effort after support is revoked and restores only managed disables", () => {
    const previous = { allowed: { variants: { personal: { reasoningEffort: "low", temperature: 0 } } } };
    const disabled = preserveOpenCodeVariants(fresh(), previous);
    expect((disabled.allowed as any).variants.personal).toMatchObject({ disabled: true, reasoningEffort: "low", temperature: 0 });
    const restored = preserveOpenCodeVariants(toOpenCodeModels([model({ id: "allowed", opper: { reasoning: { supported: ["low"] } } })]), disabled);
    expect((restored.allowed as any).variants.personal).toEqual({ reasoningEffort: "low", temperature: 0 });
  });
});
