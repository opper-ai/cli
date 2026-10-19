import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchConductorModelCatalog, toConductorModelCatalog } from "../../src/setup/conductor-models.js";
import type { CodexCompatModel } from "../../src/setup/codex-models.js";

const entry = (id: string, kind: "model" | "pool" | "dynamic_route" = "model", extra: Partial<CodexCompatModel> = {}): CodexCompatModel => ({
  id, context_length: 64000, opper: {kind, type: "llm", capabilities: ["tools"]}, ...extra,
});
afterEach(()=>vi.unstubAllGlobals());
describe("Conductor model selection",()=>{
  const entries = [entry("vendor/model"),entry("pool/with-slash","pool"),entry("bare-provider-model"),entry("dynamic/route","dynamic_route"),entry("preferred-pool","pool")];
  it("defaults to pools and routes by metadata, retaining exact IDs and selecting the requested pool first",()=>{
    const models=toConductorModelCatalog(entries,"preferred-pool").models;
    expect(models.map(model=>model.slug)).toEqual(["preferred-pool","dynamic/route","pool/with-slash"]);
    expect(models.map(model=>model.priority)).toEqual([0,1,2]);
    expect(models[0]!.display_name).toContain("(pool)");expect(models[1]!.display_name).toContain("(route)");expect(models[2]!.display_name).toContain("(pool)");
  });
  it("retains an explicitly selected deployment but excludes other provider deployments",()=>{
    const models=toConductorModelCatalog(entries,"vendor/model").models;
    expect(models.map(model=>model.slug)).toEqual(["vendor/model","dynamic/route","pool/with-slash","preferred-pool"]);
    expect(models[0]!.display_name).toContain("vendor/model");
    const bare=toConductorModelCatalog(entries,"bare-provider-model").models[0]!;
    expect(bare.display_name).toContain("· bare-provider-model");expect(bare.display_name).not.toContain("(pool)");
  });
  it("includes all providers only on request and disambiguates provider and pool labels",()=>{
    const models=toConductorModelCatalog([entry("openai/gpt-test","model",{opper:{kind:"model",type:"llm",capabilities:["tools"],display_name:"GPT Test"}}),entry("gpt-test","pool",{opper:{kind:"pool",type:"llm",capabilities:["tools"],display_name:"GPT Test"}}),entry("dynamic/route","dynamic_route")],"dynamic/route","all").models;
    expect(models.map(model=>model.slug)).toEqual(["dynamic/route","gpt-test","openai/gpt-test"]);
    expect(models.map(model=>model.display_name)).toEqual([expect.stringContaining("(route)"),"GPT Test (pool)","GPT Test · openai/gpt-test"]);
  });
  it("keeps tool-capability gating, pool reasoning intersection, and authorized IDs",()=>{
    const pool=entry("safe-pool","pool",{opper:{kind:"pool",type:"llm",members:["vendor/member"],capabilities:["tools"]}});
    const models=toConductorModelCatalog([pool,entry("no-tools","pool",{opper:{kind:"pool",type:"llm",capabilities:["text"]}}),entry("opaque-route","dynamic_route",{opper:{kind:"dynamic_route"}})],"safe-pool","pools,routes",[{id:"vendor/member",params:{reasoning:{supported:["low","high"],default:"low"}}}]).models;
    expect(models.map(model=>model.slug)).toEqual(["safe-pool"]);expect(models[0]!.supported_reasoning_levels.map(level=>level.effort)).toEqual(["low","high"]);
    expect(()=>toConductorModelCatalog([pool],"missing-pool")).toThrow(/not available/);
  });
  it("rejects invalid model-kind settings",()=>{
    expect(()=>toConductorModelCatalog(entries,"preferred-pool","models" as "all")).toThrow(/model-kinds/);
  });
  it("preserves central labels from top-level display_name and name",()=>{
    const models=toConductorModelCatalog([entry("named-pool","pool",{display_name:"Central Pool Name"}),entry("vendor/model","model",{name:"Central Deployment Name"})],"named-pool","all").models;
    expect(models.map(model=>model.display_name)).toEqual(["Central Pool Name (pool)","Central Deployment Name · vendor/model"]);
  });
  it("adds one route badge for prefixed and opaque route IDs",()=>{
    const models=toConductorModelCatalog([entry("opaque-route","dynamic_route"),entry("dynamic/named-route","dynamic_route")],"opaque-route").models;
    expect(models.map(model=>model.display_name)).toEqual(["Opaque Route (route) · Variable pricing","Named Route (route) · Variable pricing"]);
  });
  it("fetches the caller-scoped catalog and reasoning metadata without an unrestricted fallback",async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(Response.json({data:entries})).mockResolvedValueOnce(Response.json({models:[]}));vi.stubGlobal("fetch",fetch);
    const result=await fetchConductorModelCatalog({apiKey:"fake-key",baseUrl:"https://test.example",projectUuid:"11111111-1111-4111-8111-111111111111"},"preferred-pool");
    expect(result.models.map(model=>model.slug)).toEqual(["preferred-pool","dynamic/route","pool/with-slash"]);
    expect(fetch.mock.calls.map(call=>String(call[0]))).toEqual(["https://test.example/v3/compat/models","https://test.example/v3/models?limit=0"]);
    expect(fetch.mock.calls.every(call=>call[1].headers.Authorization==="Bearer fake-key"&&call[1].headers["X-Opper-Project"]==="11111111-1111-4111-8111-111111111111")).toBe(true);
  });
  it("fails when the upstream catalog is malformed",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({data:[{id:"bad",opper:{kind:"unknown"}}]})));
    await expect(fetchConductorModelCatalog({apiKey:"fake-key",baseUrl:"https://test.example"},"preferred-pool")).rejects.toThrow(/invalid model catalog/);
  });
});
