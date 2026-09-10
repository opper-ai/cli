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
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [model()] })));
    vi.stubGlobal("fetch", request);
    await fetchCodexModelCatalog({ apiKey: "selected-key", baseUrl: "https://gateway.example/api/" }, "claude-sonnet-5");
    expect(request).toHaveBeenCalledWith("https://gateway.example/api/v3/compat/models", {
      method: "GET", headers: { Authorization: "Bearer selected-key" },
    });
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
