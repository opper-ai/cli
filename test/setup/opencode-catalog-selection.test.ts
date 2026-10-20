import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { openCodeCatalogSelection } from "../../src/setup/opencode-catalog-selection.js";
import { fetchOpenCodeModels } from "../../src/setup/opencode-models.js";
import { OpperApi } from "../../src/api/client.js";
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function home() {
 const dir = mkdtempSync(join(tmpdir(), "opper-selection-")); dirs.push(dir); vi.stubEnv("OPPER_EDITOR_HOME", dir); return dir;
}
it("preserves old authorized catalog IDs and all nested saved model references", () => {
 const dir = home(), path = join(dir, ".config/opencode/opencode.json"); mkdirSync(dirname(path), {recursive:true});
 writeFileSync(path, JSON.stringify({model:"opper/vendor/main", small_model:"opper/vendor/small", agent:{plan:{model:"opper/vendor/plan"}}, provider:{opper:{models:{"vendor/recent":{}}, whitelist:["vendor/favorite"]}}, theme:"keep"}));
 const selection = openCodeCatalogSelection("all", "vendor/explicit", [path]);
 expect(selection).toMatchObject({modelKinds:"all", selectedModel:"vendor/explicit"});
 expect(selection.preserveIds).toEqual(expect.arrayContaining(["vendor/main", "vendor/small", "vendor/plan", "vendor/recent", "vendor/favorite"]));
});
it("filters fresh discovery, expands explicitly and retains only authorized previous/selected IDs", async () => {
 const entries = [
  {id:"vendor/new",opper:{kind:"model"}}, {id:"vendor/saved",opper:{kind:"model"}},
  {id:"pool",opper:{kind:"pool"}}, {id:"dynamic/team",opper:{kind:"dynamic_route"}},
 ].map(entry => ({...entry,pricing:{prompt:"0.000001",completion:"0.000002"},opper:{...entry.opper,type:"llm",capabilities:["tools"]}}));
 vi.stubGlobal("fetch",vi.fn().mockImplementation(() => Promise.resolve(Response.json({data:entries}))));
 const api = new OpperApi({apiKey:"synthetic",baseUrl:"https://example.invalid"});
 expect(Object.keys(await fetchOpenCodeModels(api, {}))).toEqual(["dynamic/team", "pool"]);
 expect(Object.keys(await fetchOpenCodeModels(api, {preserveIds:["vendor/saved", "vendor/denied"]}))).toEqual(["dynamic/team", "pool", "vendor/saved"]);
 expect(Object.keys(await fetchOpenCodeModels(api, {modelKinds:"all", selectedModel:"vendor/new"}))).toEqual(["vendor/new", "dynamic/team", "pool", "vendor/saved"]);
});
it("rejects invalid policy before discovery", () => {
 home(); expect(() => openCodeCatalogSelection("bad" as any)).toThrow(/model-kinds/);
});

it("retains actual OpenCode recent and favorite selections from state", () => {
 const dir=home(), state=join(dir,".local/state/opencode/model.json"); mkdirSync(dirname(state),{recursive:true});
 writeFileSync(state,JSON.stringify({recent:[{providerID:"opper",modelID:"vendor/recent"}],favorite:[{providerID:"opper",modelID:"vendor/starred"},{providerID:"other",modelID:"vendor/other"}]}));
 expect(openCodeCatalogSelection().preserveIds).toEqual(expect.arrayContaining(["vendor/recent","vendor/starred"]));
 expect(openCodeCatalogSelection().preserveIds).not.toContain("vendor/other");
 expect(openCodeCatalogSelection(undefined,"opper/vendor/explicit").selectedModel).toBe("vendor/explicit");
});

it("refuses an explicit unavailable model before catalog substitution", async () => {
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({data:[]})));
 await expect(fetchOpenCodeModels(new OpperApi({apiKey:"synthetic",baseUrl:"https://example.invalid"}),{selectedModel:"vendor/unavailable"})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
});
