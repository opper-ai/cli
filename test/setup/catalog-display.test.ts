import { afterEach, describe, expect, it, vi } from "vitest";
import { preserveOpenCodeVariants, toOpenCodeModels, type CompatModel } from "../../src/setup/opencode-models.js";
import { fetchCodexModelCatalog, toCodexModelCatalog } from "../../src/setup/codex-models.js";
import { fetchPiModels } from "../../src/setup/pi-models.js";

function entry(id: string, kind: "model" | "pool" | "dynamic_route", display_name?: string): CompatModel {
  return { id, context_length: 128_000, pricing: { prompt: "0.000001", completion: "0.000002" },
    opper: { kind, type: "llm", display_name, capabilities: ["tools"], max_output_tokens: 4096,
      ...(kind === "dynamic_route" ? { pricing: { kind: "variable" } } : {}) } } as CompatModel;
}

afterEach(() => vi.unstubAllGlobals());

describe("central catalog display metadata", () => {
  it("keeps exact human names separate from route IDs and never invents route prices", () => {
    const route = entry("dynamic/team-regular", "dynamic_route", "Nitor Work Smart - Regular");
    expect(toOpenCodeModels([route])).toMatchObject({ [route.id]: {
      name: "Nitor Work Smart - Regular (route) · Variable pricing",
    } });
    expect(toOpenCodeModels([route])[route.id]).not.toHaveProperty("cost");
    expect(toCodexModelCatalog([route], route.id).models[0]).toMatchObject({
      slug: route.id, display_name: "Nitor Work Smart - Regular (route) · Variable pricing",
    });
  });

  it("removes stale route zero rates on metadata refresh while preserving ordinary numeric rates", () => {
    const route = entry("dynamic/team-regular", "dynamic_route", "Work Smart v2");
    const concrete = entry("vendor/regular", "model", "Work Smart v2");
    const fresh = toOpenCodeModels([route, concrete]);
    const refreshed = preserveOpenCodeVariants(fresh, {
      [route.id]: { name: "Old route", cost: { input: 0, output: 0 }, options: { textVerbosity: "low" } },
    });
    expect(refreshed[route.id]).not.toHaveProperty("cost");
    expect(refreshed[route.id]).toMatchObject({ options: { textVerbosity: "low" } });
    expect(refreshed[concrete.id]).toMatchObject({ cost: { input: 1, output: 2 } });
  });

  it.each([undefined, "", "   "])("falls back for legacy or blank route labels: %j", (name) => {
    const route = entry("dynamic/team-regular", "dynamic_route", name);
    expect(toOpenCodeModels([route])[route.id]?.name).toBe("Team Regular (route) · Variable pricing");
    expect(toCodexModelCatalog([route], route.id).models[0]?.display_name).toBe("Team Regular (route) · Variable pricing");
  });

  it("retains deployment IDs and pool badges with centrally configured labels", () => {
    const concrete = entry("vendor/regular", "model", "Work Smart v2");
    const pool = entry("regular", "pool", "Work Smart v2");
    const mapped = toOpenCodeModels([concrete, pool]);
    expect(mapped[concrete.id]?.name).toBe("Work Smart v2 · vendor/regular");
    expect(mapped[pool.id]?.name).toBe("Work Smart v2 (pool)");
    expect(mapped[concrete.id]?.cost).toEqual({ input: 1, output: 2 });
    expect(toCodexModelCatalog([concrete], concrete.id).models[0]?.display_name).toBe("Work Smart v2");
  });

  it("maps the same route name and pricing qualifier into Pi", async () => {
    const route = entry("dynamic/team-regular", "dynamic_route", "Nitor Work Smart - Regular");
    delete route.pricing;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [route] })));
    expect((await fetchPiModels({ apiKey: "synthetic", baseUrl: "https://example.invalid" }))[0]).toMatchObject({
      id: route.id, name: "Nitor Work Smart - Regular (route) · Variable pricing",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it("retains central metadata through Codex's discovery validation", async () => {
    const route = entry("dynamic/team-regular", "dynamic_route", "Nitor Work Smart - Regular");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [route] }))
      .mockResolvedValueOnce(Response.json({ models: [] })));
    const result = await fetchCodexModelCatalog({ apiKey: "synthetic", baseUrl: "https://example.invalid" }, route.id);
    expect(result.models[0]?.display_name).toBe("Nitor Work Smart - Regular (route) · Variable pricing");
  });
});
