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
