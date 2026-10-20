import { afterEach, expect, it, vi } from "vitest";
import { nativeCodexCatalog, nativeCodexRefreshKinds, supportsNativeCodexCatalog } from "../../src/setup/codex-native-catalog.js";
import { toCodexModelCatalog } from "../../src/setup/codex-models.js";
const run = vi.hoisted(() => vi.fn());
vi.mock("../../src/util/run.js", () => ({ run }));
afterEach(() => { vi.unstubAllGlobals(); run.mockReset(); });
const context = { apiKey: "synthetic", baseUrl: "https://example.invalid/tenant", projectUuid: "project" };
const model = "provider/exact model";
const catalog = () => toCodexModelCatalog([{ id: model, opper: { kind: "model", type: "llm", capabilities: ["tools"] } }], model);
it("uses only an explicitly enabled runtime capability, without forcing feature overrides", () => {
  for (const stdout of ["codex-cli 0.163.0", "api_key_model_discovery stable false", ""]) {
    run.mockReturnValue({ code: 0, stdout }); expect(supportsNativeCodexCatalog("/runtime/codex")).toBe(false);
  }
  run.mockReturnValue({ code: 0, stdout: "api_key_model_discovery                  stable             true\n" });
  expect(supportsNativeCodexCatalog("/runtime/codex")).toBe(true);
  expect(run).toHaveBeenLastCalledWith("/runtime/codex", ["features", "list"], { timeout: 5_000 });
});
it("probes authenticated native metadata with exact selection, kind policy and project", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json(catalog())); vi.stubGlobal("fetch", fetch);
  const result = await nativeCodexCatalog(context, model, "pools,routes");
  const url = new URL(result!.url);
  expect(url.pathname).toBe("/tenant/v3/compat/models");
  expect(url.searchParams.get("format")).toBe("codex");
  expect(url.searchParams.get("type")).toBe("pool,dynamic_route");
  expect(url.searchParams.get("selected_model")).toBe(model);
  expect(fetch.mock.calls[0]![1]).toMatchObject({redirect:"error", signal:expect.any(AbortSignal)});
  expect(fetch.mock.calls[0]![1].headers).toMatchObject({ Authorization: "Bearer synthetic", "X-Opper-Project": "project" });
  expect(result!.modelCount).toBe(1);
});
it("omits type for broad native compatibility catalogs and falls back only for a legacy envelope", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(catalog())).mockResolvedValueOnce(Response.json({ data: [{ id: model }] })); vi.stubGlobal("fetch", fetch);
  expect(new URL((await nativeCodexCatalog(context, model, "all"))!.url).searchParams.has("type")).toBe(false);
  expect(await nativeCodexCatalog(context, model)).toBeUndefined();
});
it("does not mask authorization, schema, empty or unavailable selection failures as unsupported format", async () => {
  for (const body of [{ models: [] }, { models: [{ slug: model }] }, { models: [catalog().models[0], catalog().models[0]] }, { data: [{ id: 42 }] }, { models: [], data: [] }]) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
    await expect(nativeCodexCatalog(context, model)).rejects.toThrow();
  }
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [] }, { status: 401 })));
  await expect(nativeCodexCatalog(context, model)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  await expect(nativeCodexCatalog(context, model)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
});

it("checks capability in the selected Codex home", () => {
  run.mockReturnValue({code:0,stdout:"api_key_model_discovery stable false"});
  expect(supportsNativeCodexCatalog("/runtime/codex", "/isolated/codex")).toBe(false);
  expect(run).toHaveBeenCalledWith("/runtime/codex",["features","list"],{timeout:5000,env:{...process.env,CODEX_HOME:"/isolated/codex"}});
});
it("preserves prior authorized selections when refreshing native policy", () => {
  const compact = "https://example.invalid/v3/compat/models?format=codex&type=pool,dynamic_route&selected_model=old";
  expect(nativeCodexRefreshKinds("old",undefined,compact)).toBe("pools,routes");
  expect(nativeCodexRefreshKinds("new",undefined,compact)).toBe("all");
  expect(nativeCodexRefreshKinds("old","pools,routes",compact,true)).toBe("all");
  expect(nativeCodexRefreshKinds("old","pools,routes",compact.replace("type=pool,dynamic_route&", ""))).toBe("all");
});

it("passes native feature overrides in their actual order", () => {
  run.mockReturnValue({code:0,stdout:"api_key_model_discovery stable false"});
  const flags=["--enable=api_key_model_discovery","--disable","api_key_model_discovery"];
  expect(supportsNativeCodexCatalog("codex",undefined,flags)).toBe(false);
  expect(run).toHaveBeenCalledWith("codex",["features","list",...flags],{timeout:5000});
});
