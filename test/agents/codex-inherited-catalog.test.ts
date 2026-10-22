import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const fixture = vi.hoisted(() => ({home:"", layers:new Map<string,string | Error>(), catalog:vi.fn()}));
vi.mock("node:os", async () => ({...await vi.importActual<typeof import("node:os")>("node:os"),homedir:()=>fixture.home,platform:()=>"darwin"}));
vi.mock("node:fs", async () => {
  const actual=await vi.importActual<typeof import("node:fs")>("node:fs");
  return {...actual,existsSync:(path:string)=>path.startsWith("/Applications/ChatGPT.app") || actual.existsSync(path)};
});
vi.mock("node:fs/promises", async () => {
  const actual=await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {...actual,readFile:async(path:Parameters<typeof actual.readFile>[0], options:Parameters<typeof actual.readFile>[1])=>{
    if(typeof path==="string" && path.startsWith("/etc/codex/")) {
      const value=fixture.layers.get(path);
      if(value instanceof Error) throw value;
      if(value===undefined) throw Object.assign(new Error("missing fixture"),{code:"ENOENT"});
      return value;
    }
    return actual.readFile(path,options);
  }};
});
vi.mock("../../src/auth/config.js",()=>({getSlot:async()=>({apiKey:"synthetic",baseUrl:"https://synthetic.invalid",orgId:42}),isSlotExpired:()=>false}));
vi.mock("../../src/util/run.js",()=>({run:(command:string,args:string[])=>({code:0,stderr:"",stdout:command.endsWith("plutil")
  ? args.at(-1)?.includes("Conductor.app") ? "com.conductor.app" : "com.openai.codex"
  : args[0]==="features" ? "api_key_model_discovery stable true" : "codex-cli 0.163.0"})}));
vi.mock("../../src/setup/codex-models.js",async()=>({...await vi.importActual<typeof import("../../src/setup/codex-models.js")>("../../src/setup/codex-models.js"),fetchCodexModelCatalog:fixture.catalog}));
vi.mock("../../src/setup/conductor-models.js",async()=>({...await vi.importActual<typeof import("../../src/setup/conductor-models.js")>("../../src/setup/conductor-models.js"),fetchConductorModelCatalog:fixture.catalog}));
const {codexDesktop}=await import("../../src/agents/codex-desktop.js");
const {conductor}=await import("../../src/agents/conductor.js");
const {toCodexModelCatalog}=await import("../../src/setup/codex-models.js");
const model="dynamic/fixture";
const original='model="personal"\n';
let home:string, codexHome:string;
const options=()=>({keyName:"fixture",model,baseUrl:"https://synthetic.invalid"});
function snapshot(path:string):unknown {
  return !existsSync(path) ? undefined : Object.fromEntries(readdirSync(path,{withFileTypes:true}).map(entry=>[entry.name,entry.isDirectory()?snapshot(join(path,entry.name)):readFileSync(join(path,entry.name),"utf8")]));
}
beforeEach(()=>{
  home=mkdtempSync(join(tmpdir(),"opper-inherited-"));fixture.home=home;fixture.layers.clear();fixture.catalog.mockReset();
  codexHome=join(home,"codex");mkdirSync(codexHome);writeFileSync(join(codexHome,"config.toml"),original);
  const runtime=join(home,"Library/Application Support/com.conductor.app/agent-binaries/codex/0.163.0/codex");mkdirSync(dirname(runtime),{recursive:true});writeFileSync(runtime,"fixture",{mode:0o700});
  vi.stubEnv("OPPER_HOME",join(home,"opper"));vi.stubEnv("CODEX_HOME",codexHome);vi.stubEnv("OPPER_API_KEY",undefined);vi.stubEnv("OPPER_BASE_URL",undefined);vi.stubEnv("OPPER_DISTRIBUTION",undefined);
  vi.stubGlobal("fetch",vi.fn().mockImplementation(()=>Promise.resolve(Response.json(toCodexModelCatalog([{id:model,opper:{kind:"dynamic_route",capabilities:["tools"]}}],model)))));
  vi.spyOn(console,"log").mockImplementation(()=>{});
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks();rmSync(home,{recursive:true,force:true});});
// These lifecycle fixtures simulate macOS application discovery and runtime
// layouts. Windows system-path behavior is covered by the CLI detector tests.
describe.skipIf(process.platform === "win32")("macOS Codex harness catalog preservation",()=>{
describe.each(["desktop","conductor"] as const)("%s inherited catalogs",agent=>{
  const configure=()=>agent==="desktop"?codexDesktop.configure({...options(),codexHome}):conductor.configure(options());
  const provider=agent==="desktop"?"opper-desktop":"opper-conductor";
  it.each(["config.toml","requirements.toml","managed_config.toml"])("preserves a host local catalog in %s before discovery or mutation",async name=>{
    fixture.layers.set(`/etc/codex/${name}`,'model_catalog_json="/managed/models.json"');
    await expect(configure()).rejects.toMatchObject({code:"AGENT_CONFIG_CONFLICT"});
    expect(readFileSync(join(codexHome,"config.toml"),"utf8")).toBe(original);expect(existsSync(join(home,"opper"))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();expect(fixture.catalog).not.toHaveBeenCalled();
  });
  it("preserves a matching inherited provider URL without probing or replacing it",async()=>{
    fixture.layers.set("/etc/codex/config.toml",`[model_providers.${provider}]\nmodel_catalog_url="https://manual.invalid/catalog"`);
    await expect(configure()).rejects.toMatchObject({code:"AGENT_CONFIG_CONFLICT"});
    expect(fetch).not.toHaveBeenCalled();expect(fixture.catalog).not.toHaveBeenCalled();
  });
  it("leaves an owned installation unchanged when host requirements add a catalog",async()=>{
    await configure();const before=snapshot(home);vi.mocked(fetch).mockClear();
    fixture.layers.set("/etc/codex/requirements.toml",'model_catalog_json="/required/models.json"');
    await expect(configure()).rejects.toMatchObject({code:"AGENT_CONFIG_CONFLICT"});
    expect(snapshot(home)).toEqual(before);expect(fetch).not.toHaveBeenCalled();
  });
});
it("preserves a personal Conductor local catalog instead of shadowing it with generated metadata",async()=>{
  writeFileSync(join(codexHome,"config.toml"),'model_catalog_json="/personal/models.json"\n');
  await expect(conductor.configure(options())).rejects.toMatchObject({code:"AGENT_CONFIG_CONFLICT"});
  expect(readFileSync(join(codexHome,"config.toml"),"utf8")).toBe('model_catalog_json="/personal/models.json"\n');
  expect(existsSync(join(home,"opper"))).toBe(false);expect(fetch).not.toHaveBeenCalled();expect(fixture.catalog).not.toHaveBeenCalled();
});

});
