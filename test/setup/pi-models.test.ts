import { afterEach, expect, it, vi } from "vitest";
import { fetchPiModels } from "../../src/setup/pi-models.js";
const ctx={baseUrl:"https://api.example.invalid",apiKey:"synthetic",projectUuid:"target-project"};
const model=(id:string, extra={})=>({id,context_length:128000,opper:{type:"llm",capabilities:["tools","vision"],max_output_tokens:4096},...extra});
afterEach(()=>vi.unstubAllGlobals());
it("discovers new deployments, pools and routes with the credential and project target",async()=>{
 const fetch=vi.fn().mockResolvedValue(Response.json({data:[model("vendor/new-model"),model("new-pool"),model("dynamic/team")]}));vi.stubGlobal("fetch",fetch);
 const models=await fetchPiModels(ctx);expect(models.map(m=>m.id)).toEqual(["vendor/new-model","new-pool","dynamic/team"]);
 expect(models[0]).toMatchObject({input:["text","image"],contextWindow:128000,maxTokens:4096});
 expect(fetch.mock.calls[0][0].toString()).toBe("https://api.example.invalid/v3/compat/models");
 expect(fetch.mock.calls[0][1].headers).toMatchObject({Authorization:"Bearer synthetic","X-Opper-Project":"target-project"});
});
it("rejects malformed, empty and non-agent catalogs rather than returning static defaults",async()=>{
 for(const response of [{},{data:[]},{data:[model("embedding",{opper:{type:"embedding",capabilities:["tools"],max_output_tokens:4096}}),model("opaque-route",{opper:{kind:"dynamic_route"}})]}]){
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json(response)));await expect(fetchPiModels(ctx)).rejects.toThrow();
 }
});
it("propagates authorization failure",async()=>{
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({error:{message:"Denied"}},{status:403})));await expect(fetchPiModels(ctx)).rejects.toThrow();
});

it("maps only advertised reasoning efforts and explicitly hides unsupported Pi levels", async () => {
 vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({data:[model("limited", {
  opper:{capabilities:["tools","reasoning"],max_output_tokens:4096,reasoning:{supported:["none","low","high","max"]}},
 })]})));
 const [entry] = await fetchPiModels(ctx);
 expect(entry).toMatchObject({reasoning:true,thinkingLevelMap:{off:"none",minimal:null,low:"low",medium:null,high:"high",xhigh:null,max:"max"}});
});

it("hides off when the endpoint cannot disable reasoning", async () => {
 vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({data:[model("always-on", {
  opper:{capabilities:["tools"],max_output_tokens:4096,reasoning:{supported:["medium"]}},
 })]})));
 expect((await fetchPiModels(ctx))[0]).toMatchObject({reasoning:true,thinkingLevelMap:{off:null,minimal:null,low:null,medium:"medium",high:null,xhigh:null,max:null}});
});

it("does not infer selectable reasoning effort from thinking capability alone", async () => {
 vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({data:[model("thinking-only", {
  opper:{capabilities:["tools","thinking"],max_output_tokens:4096},
 }), model("unknown-efforts", {opper:{capabilities:["tools","reasoning"],max_output_tokens:4096,reasoning:{supported:["invented"]}}})]})));
 for (const entry of await fetchPiModels(ctx)) expect(entry).toMatchObject({reasoning:false,compat:{supportsReasoningEffort:false}});
});

it("converts catalog USD-per-token prices to Pi per-million-token rates including caches", async () => {
 vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({data:[model("priced", {
  pricing:{prompt:"0.0000002",completion:"0.000003",input_cache_read:"0.00000002",input_cache_write:"0.00000025"},
 })]})));
 expect((await fetchPiModels(ctx))[0]).toMatchObject({cost:{input:0.2,output:3,cacheRead:0.02,cacheWrite:0.25}});
});

it("does not export negative or malformed prices", async () => {
 vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({data:[model("unknown-price", {
  pricing:{prompt:"-1",completion:"oops",input_cache_read:"1junk",input_cache_write:"Infinity"},
 })]})));
 expect((await fetchPiModels(ctx))[0]).toMatchObject({cost:{input:0,output:0,cacheRead:0,cacheWrite:0}});
});

it("exposes max effort on the legacy Pi xhigh selector", async () => {
 vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({data:[model("max-only", {
  opper:{capabilities:["tools"],max_output_tokens:4096,reasoning:{supported:["high","max"]}},
 })]})));
 expect((await fetchPiModels(ctx, {legacyMaxLevel:true}))[0]?.thinkingLevelMap.xhigh).toBe("max");
});
