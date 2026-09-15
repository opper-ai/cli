import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchCodexModelCatalog,
  toCodexModelCatalog,
  type CodexCompatModel,
} from "../../src/setup/codex-models.js";

function model(overrides: Partial<CodexCompatModel> = {}): CodexCompatModel {
  return {
    id: "claude-sonnet-5",
    context_length: 1_000_000,
    opper: { kind: "pool", type: "llm", capabilities: ["text", "tools", "vision"] },
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("toCodexModelCatalog", () => {
  it("preserves gateway IDs and labels, with the selected model first", () => {
    const catalog = toCodexModelCatalog([
      model({ id: "provider/other", display_name: "Exact Label v2" }),
      model(),
    ], "claude-sonnet-5");
    expect(catalog.models.map((entry) => entry.slug)).toEqual(["claude-sonnet-5", "provider/other"]);
    expect(catalog.models.map((entry) => entry.display_name)).toEqual(["Claude Sonnet 5", "Exact Label v2"]);
    expect(catalog.models[0]?.priority).toBeLessThan(catalog.models[1]!.priority);
  });

  it("excludes models without confirmed text tool support", () => {
    const catalog = toCodexModelCatalog([
      model(),
      model({ id: "embed", opper: { type: "embedding", capabilities: ["tools"] } }),
      model({ id: "chat-only", opper: { type: "llm", capabilities: ["text"] } }),
      model({ id: "unknown", opper: { type: "llm" } }),
      model({ id: "dynamic/unknown", opper: { kind: "dynamic_route" } }),
    ], "claude-sonnet-5");
    expect(catalog.models.map((entry) => entry.slug)).toEqual(["claude-sonnet-5"]);
  });

  it("includes routes only when they advertise tool support", () => {
    const entry = model({ id: "dynamic/coding", opper: { kind: "dynamic_route", capabilities: ["tools"] } });
    expect(toCodexModelCatalog([entry], entry.id).models[0]?.slug).toBe(entry.id);
  });

  it("rejects a selected model absent from the authorized catalog", () => {
    expect(() => toCodexModelCatalog([model()], "provider/restricted")).toThrow(/not available.*tool/i);
    expect(() => toCodexModelCatalog([], "claude-sonnet-5")).toThrow(/No tool-capable/);
  });

  it("maps known context and vision support without inventing advanced tool capabilities", () => {
    const entry = toCodexModelCatalog([model()], "claude-sonnet-5").models[0]!;
    expect(entry.context_window).toBe(1_000_000);
    expect(entry.input_modalities).toEqual(["text", "image"]);
    expect(entry.shell_type).toBe("shell_command");
    expect(entry.experimental_supported_tools).toEqual([]);
    expect(entry.supported_reasoning_levels).toEqual([]);
    expect(entry.support_verbosity).toBe(false);
    expect(entry).not.toHaveProperty("apply_patch_tool_type");
    expect(entry).not.toHaveProperty("model_messages");
    expect(entry).not.toHaveProperty("tool_mode");
    expect(entry.base_instructions).not.toMatch(/GPT|OpenAI/);
  });

  it("uses exact model metadata, canonical effort order and the model default", () => {
    const entry = model({ id: "provider/reasoner", opper: { kind: "model", type: "llm", capabilities: ["tools"] } });
    const catalog = toCodexModelCatalog([entry], entry.id, [
      { id: entry.id, params: { reasoning: { supported: ["high", "low", "future", "low", "max"], default: "high" } } },
      { id: "unauthorized", params: { reasoning: { supported: ["medium"], default: "medium" } } },
    ]);
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]?.supported_reasoning_levels.map((level) => level.effort)).toEqual(["low", "high", "max"]);
    expect(catalog.models[0]?.default_reasoning_level).toBe("high");
    expect(catalog.models[0]?.supports_reasoning_summaries).toBe(true);
    expect(catalog.models[0]?.default_reasoning_summary).toBe("none");
  });

  it("intersects every pool member and selects a valid default", () => {
    const entry = model({ opper: { kind: "pool", type: "llm", capabilities: ["tools"], members: ["a", "b"] } });
    const metadata = [
      { id: "a", params: { reasoning: { supported: ["low", "medium", "high"], default: "high" } } },
      { id: "b", params: { reasoning: { supported: ["medium", "high", "max"], default: "medium" } } },
    ];
    const result = toCodexModelCatalog([entry], entry.id, metadata).models[0]!;
    expect(result.supported_reasoning_levels.map((level) => level.effort)).toEqual(["medium", "high"]);
    expect(result.default_reasoning_level).toBe("medium");
    metadata[1]!.params.reasoning.default = "high";
    expect(toCodexModelCatalog([entry], entry.id, metadata).models[0]?.default_reasoning_level).toBe("high");
    expect(toCodexModelCatalog([entry], entry.id, metadata.slice(0, 1)).models[0]?.supported_reasoning_levels).toEqual([]);
    metadata[1]!.params.reasoning.supported = ["max"];
    expect(toCodexModelCatalog([entry], entry.id, metadata).models[0]?.supported_reasoning_levels).toEqual([]);
  });

  it("does not guess efforts from capabilities, IDs, missing pool members or unknown levels", () => {
    for (const entry of [
      model(),
      model({ id: "provider/unknown", opper: { kind: "model", type: "llm", capabilities: ["tools", "reasoning"] } }),
      model({ id: "dynamic/coding", opper: { kind: "dynamic_route", capabilities: ["tools"] } }),
    ]) {
      const result = toCodexModelCatalog([entry], entry.id, [{ id: "other", params: { reasoning: { supported: ["high"] } } }]).models[0]!;
      expect(result.supported_reasoning_levels).toEqual([]);
      expect(result.supports_reasoning_summaries).toBe(false);
      expect(result).not.toHaveProperty("default_reasoning_level");
    }
    const entry = model({ opper: { kind: "model", type: "llm", capabilities: ["tools"] } });
    for (const supported of [["future"], ["high", "max"]]) {
      const result = toCodexModelCatalog([entry], entry.id, [{ id: entry.id, params: { reasoning: { supported, default: "invalid" } } }]).models[0]!;
      expect(result.default_reasoning_level).toBe(supported[0] === "future" ? undefined : "high");
    }
  });

  it("uses conservative bounds for missing or invalid context metadata", () => {
    for (const value of [0, -1, Number.NaN]) {
      const entry = toCodexModelCatalog([model({ context_length: value, opper: { type: "llm", capabilities: ["tools"] } })], "claude-sonnet-5").models[0]!;
      expect(entry.context_window).toBe(32_000);
      expect(entry.input_modalities).toEqual(["text"]);
    }
  });

  it("keeps IDs distinct even when their derived display names match", () => {
    const catalog = toCodexModelCatalog([model(), model({ id: "anthropic/claude-sonnet-5" })], "claude-sonnet-5");
    expect(catalog.models).toHaveLength(2);
    expect(new Set(catalog.models.map((entry) => entry.slug)).size).toBe(2);
  });
});

describe("fetchCodexModelCatalog", () => {
  it("discovers with the selected credential and custom API root", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [
        model({ opper: { kind: "pool", type: "llm", capabilities: ["tools"], members: ["provider/a", "provider/b"] } }),
        model({ id: "provider/a", opper: { kind: "model", type: "llm", capabilities: ["tools"] } }),
      ] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [
        { id: "provider/a", params: { reasoning: { supported: ["none", "low", "medium", "high"], default: "none" } } },
        { id: "provider/b", params: { reasoning: { supported: ["medium", "high", "max"], default: "high" } } },
      ] })));
    vi.stubGlobal("fetch", request);
    const catalog = await fetchCodexModelCatalog({ apiKey: "selected-key", baseUrl: "https://gateway.example/api/" }, "claude-sonnet-5");
    expect(catalog.models.map((entry) => ({
      id: entry.slug,
      efforts: entry.supported_reasoning_levels.map((level) => level.effort),
      default: entry.default_reasoning_level,
    }))).toEqual([
      { id: "claude-sonnet-5", efforts: ["medium", "high"], default: "medium" },
      { id: "provider/a", efforts: ["none", "low", "medium", "high"], default: "none" },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith("https://gateway.example/api/v3/models?limit=0", {
      method: "GET", headers: { Authorization: "Bearer selected-key" },
    });
    expect(request).toHaveBeenCalledWith("https://gateway.example/api/v3/compat/models", {
      method: "GET", headers: { Authorization: "Bearer selected-key" },
    });
  });

  it("accepts absent, null and empty reasoning metadata without enabling effort", async () => {
    for (const params of [undefined, null, {}, { reasoning: null }, { reasoning: { supported: [], default: "none" } }]) {
      const entry = model({ id: "provider/a", opper: { kind: "model", type: "llm", capabilities: ["tools", "reasoning"] } });
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [entry] })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ id: entry.id, params }] }))));
      const result = (await fetchCodexModelCatalog({ apiKey: "selected", baseUrl: "https://gateway.example" }, entry.id)).models[0]!;
      expect(result.supported_reasoning_levels).toEqual([]);
      expect(result.supports_reasoning_summaries).toBe(false);
      expect(result).not.toHaveProperty("default_reasoning_level");
    }
  });

  it("rejects unauthorized or malformed reasoning metadata", async () => {
    for (const response of [
      new Response("", { status: 401 }),
      new Response(JSON.stringify({})),
      new Response(JSON.stringify({ models: [{ id: "a", params: { reasoning: { supported: "high" } } }] })),
    ]) {
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [model()] })))
        .mockResolvedValueOnce(response));
      await expect(fetchCodexModelCatalog({ apiKey: "selected", baseUrl: "https://gateway.example" }, "claude-sonnet-5"))
        .rejects.toMatchObject({ code: response.status === 401 ? "AUTH_EXPIRED" : "API_ERROR" });
    }
  });

  it("does not replace rejected credentials with a baked catalog", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    await expect(fetchCodexModelCatalog({ apiKey: "expired", baseUrl: "https://gateway.example" }, "claude-sonnet-5"))
      .rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("fails on malformed catalog responses instead of writing empty configuration", async () => {
    for (const body of [{}, { data: {} }, { data: [{ id: 42 }] }]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
      await expect(fetchCodexModelCatalog({ apiKey: "selected", baseUrl: "https://gateway.example" }, "claude-sonnet-5"))
        .rejects.toMatchObject({ code: "API_ERROR" });
    }
  });
});
