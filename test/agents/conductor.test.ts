import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { setSlot, deleteSlot } from "../../src/auth/config.js";
import { readDesktopConfig } from "../../src/setup/codex-desktop-config.js";

const mocks = vi.hoisted(() => ({ home: "", platform: "darwin", run: vi.fn(), catalog: vi.fn(), failRename: "", failRemove: "", beforeRename: undefined as ((to: string) => void) | undefined }));
vi.mock("node:os", async () => ({ ...await vi.importActual<typeof import("node:os")>("node:os"), homedir: () => mocks.home, platform: () => mocks.platform }));
vi.mock("../../src/util/run.js", () => ({ run: mocks.run }));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {...actual, rename: async (from: string, to: string) => {
    if (to === mocks.failRename) {mocks.failRename="";throw new Error("synthetic mid-write failure");}
    mocks.beforeRename?.(to);
    return actual.rename(from,to);
  }, rm: async (path: string, options?: Parameters<typeof actual.rm>[1]) => {
    if(path===mocks.failRemove){mocks.failRemove="";throw new Error("synthetic removal failure");}
    return actual.rm(path,options);
  }};
});
vi.mock("../../src/setup/conductor-models.js", async () => ({ ...await vi.importActual<typeof import("../../src/setup/conductor-models.js")>("../../src/setup/conductor-models.js"), fetchConductorModelCatalog: mocks.catalog }));
const { conductor } = await import("../../src/agents/conductor.js");
const { toConductorModelCatalog } = await import("../../src/setup/conductor-models.js");
let home: string;
let managed: string;
const key = "synthetic-conductor-key";
const host = "https://synthetic.example/tenant";
const model = "dynamic/test-route";
const originalExecPath = process.execPath;
const options = () => ({ keyName: "test", apiKey: key, baseUrl: host, model });
function runtime(version = "0.162.1") {
  const target = join(home, "Library/Application Support/com.conductor.app/agent-binaries/codex", version, "codex");
  mkdirSync(dirname(target), {recursive: true});
  writeFileSync(target, `#!${process.execPath}\nif (process.argv.includes('--version')) console.log('codex-cli ${version}'); else if (process.argv.includes('features')) console.log('api_key_model_discovery stable true'); else console.log(JSON.stringify(process.argv.slice(2)));\n`, {mode: 0o700});
  return target;
}
function execute(file: string, args: string[] = []) {
  return spawnSync(join(managed, file), args, {encoding: "utf8", timeout: 5000, env: {PATH: process.env.PATH, HOME: home}});
}
function authentication() {
  const output=execute("codex",["app-server"]);expect(output.status,output.stderr).toBe(0);
  const args=JSON.parse(output.stdout) as string[];
  const provider=args.find(arg=>arg.startsWith("model_providers.opper-conductor="))!.slice("model_providers.opper-conductor=".length);
  return (readDesktopConfig(`provider = ${provider}`).provider as {auth:{command:string;args:string[]}}).auth;
}
function helper(auth=authentication()) { return spawnSync(auth.command, auth.args, {encoding: "utf8", timeout: 5000, env: {PATH: "", HOME: home}}); }
function contents() { return Object.fromEntries(readdirSync(managed).map(name => [name, readFileSync(join(managed, name), "utf8")])); }
async function holdSetupLock() {
  const modulePath=createRequire(import.meta.url).resolve("proper-lockfile");
  const script=`const lockfile=require(${JSON.stringify(modulePath)});lockfile.lock(process.argv[1],{lockfilePath:process.argv[2],realpath:false,stale:10000,update:2000}).then(()=>{process.send({ready:true});setInterval(()=>{},1000);}).catch(error=>{process.send({error:error.code});process.exit(1);});`;
  const child=spawn(originalExecPath,["-e",script,managed,join(home,".opper/.conductor.lock")],{stdio:["ignore","ignore","ignore","ipc"]});
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready=await Promise.race([once(child,"message"),new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(new Error("lock owner did not become ready")),3000);deadline.unref();})]);
    expect(ready[0]).toEqual({ready:true});return child;
  } catch(error) {if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,"exit");child.kill("SIGKILL");await stopped;}throw error;}
  finally {clearTimeout(deadline);}
}
async function stopSetupLockOwner(child: ReturnType<typeof spawn>) {
  if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,"exit");child.kill("SIGKILL");await stopped;}
  expect(()=>process.kill(child.pid!,0)).toThrow();
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "opper conductor "));mocks.home=home;managed=join(home,".opper/conductor");
  mocks.platform="darwin";mocks.failRename="";mocks.failRemove="";mocks.beforeRename=undefined;vi.stubEnv("OPPER_HOME", join(home,".opper"));vi.stubEnv("OPPER_API_KEY", undefined);vi.stubEnv("OPPER_BASE_URL", undefined);vi.stubEnv("OPPER_DISTRIBUTION", undefined);vi.stubEnv("CODEX_HOME",undefined);
  mocks.run.mockReset();mocks.run.mockImplementation((cmd: string) => ({code: 0,stdout: cmd.endsWith("plutil") ? "com.conductor.app" : "codex-cli 0.162.1",stderr:""}));
  mocks.catalog.mockReset();mocks.catalog.mockImplementation(async (_context, selected, kinds) => toConductorModelCatalog([{id:model,opper:{kind:"dynamic_route",capabilities:["tools"]}},{id:"synthetic/extra",opper:{kind:"model",type:"llm",capabilities:["tools"]}}],selected,kinds));
  await setSlot("test",{apiKey:key,baseUrl:host,orgId:42});runtime();vi.spyOn(console,"log").mockImplementation(()=>{});
});
afterEach(()=>{process.execPath=originalExecPath;vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks();rmSync(home,{recursive:true,force:true});});

describe.skipIf(process.platform === "win32")("Conductor Codex integration",()=>{
  function nativeRuntime() {
    const previous = mocks.run.getMockImplementation()!;
    mocks.run.mockImplementation((command: string, args: string[]) => args[0] === "features" ? {code:0,stdout:"api_key_model_discovery stable true",stderr:""} : previous(command,args));
  }
  function nativeMetadata() {
    return toConductorModelCatalog([{id:model,opper:{kind:"dynamic_route",capabilities:["tools"]}}], model);
  }
  function homeAwareRuntime() {
    const target=runtime();
    writeFileSync(target,`#!${process.execPath}\nconst {readFileSync}=require('node:fs'),{join}=require('node:path');const home=process.env.CODEX_HOME||join(process.env.HOME,'.codex');let text='';try{text=readFileSync(join(home,'config.toml'),'utf8')}catch{}if(process.argv.includes('--version'))console.log('codex-cli 0.162.1');else if(process.argv.includes('features'))console.log('api_key_model_discovery stable '+(!/api_key_model_discovery\\s*=\\s*false/.test(text)));else console.log(JSON.stringify({home,args:process.argv.slice(2)}));\n`,{mode:0o700});
    const previous=mocks.run.getMockImplementation()!;
    mocks.run.mockImplementation((command:string,args:string[],options?:Parameters<typeof spawnSync>[2])=>{
      if(args[0]!=="features")return previous(command,args,options);
      const output=spawnSync(command,args,{...options,encoding:"utf8"});return{code:output.status??-1,stdout:output.stdout??"",stderr:output.stderr??""};
    });
  }
  function guiLaunch(codexHome?:string) {
    return spawnSync(join(managed,"codex"),["app-server"],{encoding:"utf8",timeout:5000,env:{PATH:process.env.PATH,HOME:home,...(codexHome===undefined?{}:{CODEX_HOME:codexHome})}});
  }
  function homeConfig(name:string,text:string) {
    const path=join(home,name);mkdirSync(path,{recursive:true});writeFileSync(join(path,"config.toml"),text);return path;
  }
  it("keeps a custom discovery opt-out effective when Conductor launches without CODEX_HOME",async()=>{
    const selected=homeConfig("custom-codex",'[features]\napi_key_model_discovery=false\n');vi.stubEnv("CODEX_HOME",selected);homeAwareRuntime();
    await conductor.configure(options());expect(mocks.catalog).toHaveBeenCalledTimes(1);
    const launched=guiLaunch();expect(launched.status,launched.stderr).toBe(0);
    const result=JSON.parse(launched.stdout);expect(result.home).toBe(selected);expect(result.args.some((arg:string)=>arg.startsWith("model_catalog_json="))).toBe(true);
  });
  it("pins native discovery to its verified home and rejects a different workspace home before runtime startup",async()=>{
    const selected=homeConfig("custom-codex",'[features]\napi_key_model_discovery=true\n');homeConfig(".codex",'[features]\napi_key_model_discovery=false\n');
    vi.stubEnv("CODEX_HOME",selected);homeAwareRuntime();vi.stubGlobal("fetch",vi.fn().mockImplementation(()=>Promise.resolve(Response.json(nativeMetadata()))));
    await conductor.configure(options());
    for(const incoming of [undefined,selected]) {
      const launched=guiLaunch(incoming);expect(launched.status,launched.stderr).toBe(0);expect(JSON.parse(launched.stdout).home).toBe(selected);
    }
    const other=homeConfig("workspace-codex",'model_catalog_json="/workspace/catalog.json"\n');
    const mismatch=guiLaunch(other);expect(mismatch.status).toBe(1);expect(mismatch.stderr).toContain("CODEX_HOME");expect(mismatch.stderr).toContain("reconfigure");expect(mismatch.stdout).toBe("");
    expect(JSON.parse(readFileSync(join(managed,"state.json"),"utf8")).codexHome).toBe(selected);
  });
  it("retains the verified home on refresh and preserves personal homes on conflict and removal",async()=>{
    const selected=homeConfig("custom-codex",'[features]\napi_key_model_discovery=true\n');vi.stubEnv("CODEX_HOME",selected);homeAwareRuntime();vi.stubGlobal("fetch",vi.fn().mockImplementation(()=>Promise.resolve(Response.json(nativeMetadata()))));
    await conductor.configure(options());
    const other=homeConfig(".codex",'model_catalog_json="/personal/catalog.json"\n');vi.stubEnv("CODEX_HOME",undefined);
    await conductor.configure(options());expect(JSON.parse(readFileSync(join(managed,"state.json"),"utf8")).codexHome).toBe(selected);
    const before=contents();vi.stubEnv("CODEX_HOME",other);await expect(conductor.configure(options())).rejects.toMatchObject({code:"AGENT_CONFIG_CONFLICT"});expect(contents()).toEqual(before);
    await conductor.unconfigure();expect(readFileSync(join(selected,"config.toml"),"utf8")).toBe('[features]\napi_key_model_discovery=true\n');expect(readFileSync(join(other,"config.toml"),"utf8")).toBe('model_catalog_json="/personal/catalog.json"\n');
  });
  it("allows an explicit new Codex home binding without modifying either home's settings",async()=>{
    const first=homeConfig("first-codex",'[features]\napi_key_model_discovery=true\n'), second=homeConfig("second-codex",'[features]\napi_key_model_discovery=true\n');
    vi.stubEnv("CODEX_HOME",first);homeAwareRuntime();vi.stubGlobal("fetch",vi.fn().mockImplementation(()=>Promise.resolve(Response.json(nativeMetadata()))));
    await conductor.configure(options());vi.stubEnv("CODEX_HOME",second);await conductor.configure(options());
    expect(JSON.parse(readFileSync(join(managed,"state.json"),"utf8")).codexHome).toBe(second);
    const launched=guiLaunch();expect(launched.status,launched.stderr).toBe(0);expect(JSON.parse(launched.stdout).home).toBe(second);expect(guiLaunch(first).status).toBe(1);
    await conductor.unconfigure();for(const path of [first,second])expect(readFileSync(join(path,"config.toml"),"utf8")).toBe('[features]\napi_key_model_discovery=true\n');
  });
  it.each(["relative-home",42])("preserves owned state with an invalid Codex home binding: %s",async invalid=>{
    await conductor.configure(options());const statePath=join(managed,"state.json"), state=JSON.parse(readFileSync(statePath,"utf8"));state.codexHome=invalid;writeFileSync(statePath,JSON.stringify(state));
    const before=contents();await expect(conductor.configure(options())).rejects.toMatchObject({code:"AGENT_CONFIG_CONFLICT"});await expect(conductor.unconfigure()).rejects.toMatchObject({code:"AGENT_CONFIG_CONFLICT"});expect(contents()).toEqual(before);
  });
  it("uses native URL discovery on fresh supported setups without a static catalog and removes it safely", async () => {
    nativeRuntime(); vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json(nativeMetadata())));
    await conductor.configure(options());
    expect(mocks.catalog).not.toHaveBeenCalled(); expect(existsSync(join(managed,"catalog.json"))).toBe(false);
    const state=JSON.parse(readFileSync(join(managed,"state.json"),"utf8"));
    expect(new URL(state.catalogUrl).searchParams.get("type")).toBe("pool,dynamic_route");
    expect(readFileSync(join(managed,"launcher.mjs"),"utf8")).toContain("model_catalog_url");
    const launched=execute("codex",["app-server"]);expect(launched.status,launched.stderr).toBe(0);
    const args=JSON.parse(launched.stdout) as string[];
    expect(args.some(arg=>arg.startsWith("model_catalog_json="))).toBe(false);
    expect(args.find(arg=>arg.startsWith("model_providers.opper-conductor="))).toContain(state.catalogUrl);
    expect(helper().stdout).toBe(key);
    expect(await conductor.isConfigured()).toBe(true);
    await conductor.unconfigure(); expect(existsSync(managed)).toBe(false);
  });
  it.each([["--disable","api_key_model_discovery"],["--disable=api_key_model_discovery"],["--enable=api_key_model_discovery","--disable","api_key_model_discovery"]])("rejects a native wrapper invocation that disables discovery: %j", async (...flags) => {
    nativeRuntime();vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json(nativeMetadata())));
    await conductor.configure(options());
    writeFileSync(runtime(),`#!${process.execPath}\nif(process.argv.includes('--version'))console.log('codex-cli 0.162.1');else if(process.argv.includes('features'))console.log('api_key_model_discovery stable '+(!process.argv.some(arg=>arg.startsWith('--disable'))));else console.log('SHOULD_NOT_LAUNCH');\n`,{mode:0o700});
    const result=execute("codex",["app-server",...flags]);
    expect(result.status).toBe(1);expect(result.stderr).toContain("reconfigure");expect(result.stdout).not.toContain("SHOULD_NOT_LAUNCH");
  });
  it("retains full authorized local catalogs on reconfiguration before native rollout", async () => {
    await conductor.configure({...options(),modelKinds:"all"});
    await conductor.configure(options());
    expect(mocks.catalog).toHaveBeenLastCalledWith({apiKey:key,baseUrl:host},model,"all");
    expect(JSON.parse(readFileSync(join(managed,"catalog.json"),"utf8")).models.some((entry:{slug:string})=>entry.slug==="synthetic/extra")).toBe(true);
  });
  it("upgrades an owned static catalog to broad native discovery without losing prior selections", async () => {
    await conductor.configure(options()); nativeRuntime();
    vi.stubGlobal("fetch",vi.fn().mockImplementation(()=>Promise.resolve(Response.json(nativeMetadata()))));
    await conductor.configure({...options(),model:undefined});
    expect(existsSync(join(managed,"catalog.json"))).toBe(false);
    const state=JSON.parse(readFileSync(join(managed,"state.json"),"utf8"));
    expect(new URL(state.catalogUrl).searchParams.has("type")).toBe(false); expect(state.model).toBe(model);
    await conductor.configure({...options(),model:undefined});
    expect(new URL(JSON.parse(readFileSync(join(managed,"state.json"),"utf8")).catalogUrl).searchParams.has("type")).toBe(false);
  });
  it("recovers legacy project scope during native migration and retains it on refresh", async () => {
    const projectUuid="11111111-1111-4111-8111-111111111111";
    await conductor.configure({...options(),projectUuid});
    // Model the pre-native state schema while retaining the signed launcher.
    const statePath=join(managed,"state.json"), oldState=JSON.parse(readFileSync(statePath,"utf8"));delete oldState.projectUuid;writeFileSync(statePath,JSON.stringify(oldState));
    nativeRuntime();const fetch=vi.fn().mockImplementation(()=>Promise.resolve(Response.json(nativeMetadata())));vi.stubGlobal("fetch",fetch);
    await conductor.configure(options());
    expect(fetch.mock.calls.at(-1)![1].headers).toMatchObject({"X-Opper-Project":projectUuid});
    expect(JSON.parse(readFileSync(statePath,"utf8")).projectUuid).toBe(projectUuid);
    await conductor.configure(options());
    expect(fetch.mock.calls.at(-1)![1].headers).toMatchObject({"X-Opper-Project":projectUuid});
    const result=execute("codex",["app-server"]), args=JSON.parse(result.stdout) as string[];
    expect(args.find(arg=>arg.startsWith("model_providers.opper-conductor="))).toContain(projectUuid);
  });
  it("reads linked personal Codex configuration without modifying it", async () => {
    const codexHome=join(home,".codex"), linked=join(home,"personal-codex.toml");mkdirSync(codexHome);writeFileSync(linked,'model="personal"\n');symlinkSync(linked,join(codexHome,"config.toml"));
    await conductor.configure(options()); expect(readFileSync(linked,"utf8")).toBe('model="personal"\n');
  });
  it("falls back only on a legacy response and preserves setup on native auth/schema failure", async () => {
    nativeRuntime(); vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({data:[{id:model}]})));
    await conductor.configure(options()); expect(mocks.catalog).toHaveBeenCalledTimes(1);
    const before=contents(); mocks.catalog.mockClear();
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({}, {status:401})));
    await expect(conductor.configure(options())).rejects.toMatchObject({code:"AUTH_EXPIRED"});
    expect(mocks.catalog).not.toHaveBeenCalled();expect(contents()).toEqual(before);
  });
  it("reinstates an owned local fallback when native format is no longer supported", async () => {
    nativeRuntime();vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json(nativeMetadata())));
    await conductor.configure(options());
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({data:[{id:model}]})));
    await conductor.configure(options());
    expect(existsSync(join(managed,"catalog.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(managed,"state.json"),"utf8")).catalogUrl).toBeUndefined();
    expect(await conductor.isConfigured()).toBe(true);
  });
  it("does not activate or overwrite an independently configured Conductor catalog URL", async () => {
    nativeRuntime(); const codexHome=join(home,".codex");mkdirSync(codexHome);
    const path=join(codexHome,"config.toml"), before='[model_providers.opper-conductor]\nmodel_catalog_url="https://manual.example/catalog"\n';writeFileSync(path,before);
    await expect(conductor.configure(options())).rejects.toMatchObject({code:"AGENT_CONFIG_CONFLICT"});
    expect(readFileSync(path,"utf8")).toBe(before);expect(existsSync(managed)).toBe(false);
  });
  it("prepares an invocation-only wrapper and route catalog without persisting credentials or touching Codex",async()=>{
    const codex=join(home,".codex");mkdirSync(codex);writeFileSync(join(codex,"config.toml"),'# personal\nmodel="personal"\n');
    await conductor.configure(options());
    expect(mocks.catalog).toHaveBeenCalledWith({apiKey:key,baseUrl:host},model,"pools,routes");
    expect(Object.values(contents()).join("\n")).not.toContain(key);
    expect(JSON.parse(readFileSync(join(managed,"catalog.json"),"utf8")).models.map((m: {slug:string})=>m.slug)).toEqual([model]);
    expect(readFileSync(join(codex,"config.toml"),"utf8")).toBe('# personal\nmodel="personal"\n');
    const result=execute("codex",["app-server","--listen","stdio://","argument with spaces"]);expect(result.status,result.stderr).toBe(0);
    const args=JSON.parse(result.stdout) as string[];expect(args).toContain("argument with spaces");expect(args.join(" ")).toContain('model_provider="opper-conductor"');expect(args.join(" ")).toContain("model_catalog_json=");expect(args.join(" ")).toContain('web_search="disabled"');expect(args.join(" ")).toContain('"supports_websockets" = false');
    expect(await conductor.isConfigured()).toBe(true);expect(console.log).toHaveBeenCalledWith(expect.stringContaining(join(managed,"codex")));
  });
  it("reads renewed credentials but rejects revocation, expiry, organization and host changes",async()=>{
    await conductor.configure(options());expect(helper().stdout).toBe(key);
    await setSlot("test",{apiKey:"fake-renewed",baseUrl:host,orgId:42});expect(helper().stdout).toBe("fake-renewed");
    for(const update of [{expiresAt:"2000-01-01"},{orgId:43},{baseUrl:"https://another.example"}]){
      await setSlot("test",{apiKey:"fake-renewed",baseUrl:host,orgId:42,...update});const output=helper();expect(output.status).toBe(1);expect(output.stdout).toBe("");expect(output.stderr).not.toContain("fake-renewed");
    }
    await deleteSlot("test");expect(helper().status).toBe(1);
  });
  it("fails closed when an originally absent organization becomes present",async()=>{
    await setSlot("test",{apiKey:key,baseUrl:host});await conductor.configure(options());expect(helper().status).toBe(0);
    await setSlot("test",{apiKey:key,baseUrl:host,orgId:42});expect(helper().status).toBe(1);
  });
  it("keeps a running provider's credential binding after reconfiguration to another host or slot",async()=>{
    await conductor.configure(options());const runningAuth=authentication();
    await setSlot("other",{apiKey:"synthetic-other-key",baseUrl:"https://other.example",orgId:43});
    await conductor.configure({keyName:"other",apiKey:"synthetic-other-key",baseUrl:"https://other.example",model});
    expect(helper().stdout).toBe("synthetic-other-key");expect(helper(runningAuth).stdout).toBe(key);
    await setSlot("test",{apiKey:"synthetic-replaced-key",baseUrl:"https://other.example",orgId:43});expect(helper(runningAuth).status).toBe(1);expect(helper(runningAuth).stdout).toBe("");
  });
  it("rescans managed Codex versions for later Conductor upgrades",async()=>{
    await conductor.configure(options());runtime("0.163.0");
    const output=execute("codex",["--version"]);expect(output.status).toBe(0);expect(output.stdout).toContain("0.163.0");
  });
  it("refreshes the catalog idempotently and removes only its own artifacts",async()=>{
    await conductor.configure(options());await conductor.configure(options());const original=contents();await conductor.configure(options());expect(contents()).toEqual(original);
    writeFileSync(join(managed,"personal.txt"),"keep");await conductor.unconfigure();expect(readdirSync(managed)).toEqual(["personal.txt"]);expect(await conductor.isConfigured()).toBe(false);await conductor.unconfigure();
  });
  it("preserves expanded provider discovery and exact selected deployments",async()=>{
    const ids=()=>JSON.parse(readFileSync(join(managed,"catalog.json"),"utf8")).models.map((entry:{slug:string})=>entry.slug);
    await conductor.configure({...options(),modelKinds:"all"});expect(ids()).toEqual([model,"synthetic/extra"]);
    await conductor.configure(options());expect(ids()).toEqual([model,"synthetic/extra"]);
    await conductor.configure({...options(),model:"synthetic/extra"});expect(ids()).toEqual(["synthetic/extra",model]);
    await expect(conductor.configure({...options(),modelKinds:"providers" as "all"})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
    expect(ids()).toEqual(["synthetic/extra",model]);
  });
  it("preserves independently edited files on configure and remove",async()=>{
    await conductor.configure(options());writeFileSync(join(managed,"catalog.json"),"edited");const before=contents();
    await expect(conductor.configure(options())).rejects.toMatchObject({code:"AGENT_CONFIG_CONFLICT"});await expect(conductor.unconfigure()).rejects.toMatchObject({code:"AGENT_CONFIG_CONFLICT"});expect(contents()).toEqual(before);expect(await conductor.isConfigured()).toBe(false);
  });
  it("refuses unmanaged artifacts and symlinks without overwriting their targets",async()=>{
    mkdirSync(managed,{recursive:true});writeFileSync(join(managed,"codex"),"personal");await expect(conductor.configure(options())).rejects.toMatchObject({code:"AGENT_CONFIG_CONFLICT"});expect(readFileSync(join(managed,"codex"),"utf8")).toBe("personal");
    rmSync(join(managed,"codex"));const target=join(home,"personal");writeFileSync(target,"personal");symlinkSync(target,join(managed,"catalog.json"));await expect(conductor.configure(options())).rejects.toMatchObject({code:"AGENT_CONFIG_CONFLICT"});expect(readFileSync(target,"utf8")).toBe("personal");
  });
  it("rejects environment-only keys, mismatched keys/hosts and expired stored credentials",async()=>{
    vi.stubEnv("OPPER_API_KEY",key);await expect(conductor.configure(options())).rejects.toMatchObject({code:"AUTH_REQUIRED"});vi.stubEnv("OPPER_API_KEY",undefined);
    await expect(conductor.configure({...options(),apiKey:"other"})).rejects.toMatchObject({code:"AGENT_CONFIG_CONFLICT"});await expect(conductor.configure({...options(),baseUrl:"https://another.example"})).rejects.toMatchObject({code:"AGENT_CONFIG_CONFLICT"});
    await setSlot("test",{apiKey:key,baseUrl:host,expiresAt:"2000-01-01"});await expect(conductor.configure(options())).rejects.toMatchObject({code:"AUTH_EXPIRED"});expect(existsSync(managed)).toBe(false);
  });
  it("rejects unsupported platforms, bundle IDs, and old runtime versions",async()=>{
    mocks.platform="linux";expect((await conductor.detect()).installed).toBe(false);await expect(conductor.configure(options())).rejects.toMatchObject({code:"AGENT_NOT_FOUND"});mocks.platform="darwin";
    mocks.run.mockReturnValue({code:0,stdout:"com.unrelated.app",stderr:""});await expect(conductor.configure(options())).rejects.toMatchObject({code:"AGENT_NOT_FOUND"});
    mocks.run.mockImplementation((cmd:string)=>({code:0,stdout:cmd.endsWith("plutil")?"com.conductor.app":"codex-cli 0.150.0",stderr:""}));await expect(conductor.configure(options())).rejects.toMatchObject({code:"AGENT_NOT_FOUND"});
  });
  it("leaves a working installation intact when discovery fails or a setup lock is held",async()=>{
    await conductor.configure(options());const before=contents();mocks.catalog.mockRejectedValueOnce(new Error("catalog unavailable"));await expect(conductor.configure(options())).rejects.toThrow("catalog unavailable");expect(contents()).toEqual(before);
    mkdirSync(join(home,".opper/.conductor.lock"));await expect(conductor.configure(options())).rejects.toMatchObject({code:"AGENT_CONFIG_CONFLICT"});expect(contents()).toEqual(before);
  });
  it("rolls back an interrupted write without partial artifacts on setup or refresh",async()=>{
    mocks.failRename=join(managed,"catalog.json");await expect(conductor.configure(options())).rejects.toThrow("synthetic mid-write failure");expect(readdirSync(managed)).toEqual([]);
    await conductor.configure(options());const before=contents();mocks.failRename=join(managed,"catalog.json");await expect(conductor.configure({...options(),model:"synthetic/extra",modelKinds:"all"})).rejects.toThrow("synthetic mid-write failure");expect(contents()).toEqual(before);expect(await conductor.isConfigured()).toBe(true);
  });
  it("keeps bundled Node and authentication working after the original distribution is removed",async()=>{
    const bundle=join(home,"distribution");mkdirSync(bundle);
    // Homebrew Node is dynamically linked; this fixture executes the real helper
    // with our interpreter. Release bundle tests cover self-contained Node.
    writeFileSync(join(bundle,"node"),`#!/bin/sh\nexec '${originalExecPath.replace(/'/g,"'\\''")}' "$@"\n`,{mode:0o700});
    writeFileSync(join(bundle,"NODE-LICENSE"),"synthetic Node license");process.execPath=join(bundle,"node");vi.stubEnv("OPPER_DISTRIBUTION","bundle");
    await conductor.configure(options());process.execPath=originalExecPath;rmSync(bundle,{recursive:true});
    const output=execute("codex",["app-server"]);expect(output.status,output.stderr).toBe(0);expect(helper().stdout).toBe(key);expect(readFileSync(join(managed,"NODE-LICENSE"),"utf8")).toBe("synthetic Node license");
    await conductor.unconfigure();expect(existsSync(join(managed,"node"))).toBe(false);
  });
  it("forwards shutdown to its Codex child and exits with the signal",async()=>{
    await conductor.configure(options());
    writeFileSync(runtime(),`#!${originalExecPath}\nif(process.argv.includes('--version'))console.log('codex-cli 0.162.1');else{console.log(process.pid);setInterval(()=>{},1000);}\n`,{mode:0o700});
    const child=spawn(join(managed,"codex"),["app-server"],{env:{PATH:process.env.PATH,HOME:home},stdio:["ignore","pipe","pipe"]});
    const deadline=setTimeout(()=>child.kill("SIGKILL"),3000);
    try {
      const [output]=await once(child.stdout,"data");const codexPid=Number(String(output).trim());expect(Number.isSafeInteger(codexPid)).toBe(true);
      const exited=once(child,"exit");child.kill("SIGTERM");expect(await exited).toEqual([null,"SIGTERM"]);expect(()=>process.kill(codexPid,0)).toThrow();
    } finally {clearTimeout(deadline);if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");}
  });
  it("automatically selects CLI mode and restores previous settings, comments and mode on removal",async()=>{
    const path=join(home,".conductor/settings.toml");mkdirSync(dirname(path));
    const original="# preserve\ncodex_provider = 'custom'\ncodex_executable_path = '/previous/codex'\nprivate_token = 'do-not-back-up'\n";
    writeFileSync(path,original);chmodSync(path,0o640);await conductor.configure(options());
    const configured=readFileSync(path,"utf8");expect(readDesktopConfig(configured)).toMatchObject({codex_provider:"default",codex_executable_path:join(managed,"codex")});expect(statSync(path).mode&0o777).toBe(0o640);
    expect(Object.values(contents()).join("\n")).not.toContain("do-not-back-up");
    await conductor.configure(options());writeFileSync(path,configured+"# independent edit\n");await conductor.unconfigure();
    expect(readFileSync(path,"utf8")).toBe(original+"# independent edit\n");expect(statSync(path).mode&0o777).toBe(0o640);
  });
  it("removes a newly created settings file only when no independent content remains",async()=>{
    const path=join(home,".conductor/settings.toml");await conductor.configure(options());expect(existsSync(path)).toBe(true);await conductor.unconfigure();expect(existsSync(path)).toBe(false);
    await conductor.configure(options());writeFileSync(path,readFileSync(path,"utf8")+"theme = 'dark'\n");await conductor.unconfigure();expect(readFileSync(path,"utf8")).toBe("theme = 'dark'\n");
  });
  it("protects a missing or edited tracked settings backup",async()=>{
    await conductor.configure(options());const path=join(managed,"settings.json"),backup=readFileSync(path);
    rmSync(path);await expect(conductor.configure(options())).rejects.toThrow(/backup is missing/);await expect(conductor.unconfigure()).rejects.toThrow(/backup is missing/);expect(await conductor.isConfigured()).toBe(false);
    writeFileSync(path,Buffer.concat([backup,Buffer.from(" ")]));await expect(conductor.configure(options())).rejects.toThrow(/settings.json changed/);await expect(conductor.unconfigure()).rejects.toThrow(/settings.json changed/);
  });
  it("preserves independent selection changes and avoids removing a wrapper still in use with an edited provider",async()=>{
    const path=join(home,".conductor/settings.toml");await conductor.configure(options());
    writeFileSync(path,readFileSync(path,"utf8").replace('"default"','"custom"'));const before=contents();
    await expect(conductor.configure(options())).rejects.toThrow(/changed/);await expect(conductor.unconfigure()).rejects.toThrow(/provider changed/);expect(contents()).toEqual(before);
    const changed=readFileSync(path,"utf8").replace(join(managed,"codex"),"/new/codex");writeFileSync(path,changed);await conductor.unconfigure();expect(readFileSync(path,"utf8")).toBe(changed);
  });
  it("rejects symlinked settings files and directories without changing their targets",async()=>{
    const target=join(home,"personal.toml");writeFileSync(target,"theme = 'dark'\n");mkdirSync(join(home,".conductor"));symlinkSync(target,join(home,".conductor/settings.toml"));
    await expect(conductor.configure(options())).rejects.toThrow(/linked/);expect(readFileSync(target,"utf8")).toBe("theme = 'dark'\n");
    rmSync(join(home,".conductor"),{recursive:true});const targetDir=join(home,"private-settings");mkdirSync(targetDir);symlinkSync(targetDir,join(home,".conductor"));await expect(conductor.configure(options())).rejects.toThrow(/linked/);
  });
  it("rolls back managed files and external settings on failure before or after the settings write",async()=>{
    const path=join(home,".conductor/settings.toml");mkdirSync(dirname(path));const original="codex_provider = 'custom'\n";writeFileSync(path,original);
    for(const failedPath of [path,join(managed,"state.json")]){
      mocks.failRename=failedPath;await expect(conductor.configure(options())).rejects.toThrow("synthetic mid-write failure");expect(readFileSync(path,"utf8")).toBe(original);expect(readdirSync(managed)).toEqual([]);
    }
  });
  it("rolls back settings restoration if removing a managed file fails",async()=>{
    const path=join(home,".conductor/settings.toml");await conductor.configure(options());const selected=readFileSync(path,"utf8"),before=contents();
    mocks.failRemove=join(managed,"auth.mjs");await expect(conductor.unconfigure()).rejects.toThrow("synthetic removal failure");expect(contents()).toEqual(before);expect(readFileSync(path,"utf8")).toBe(selected);expect(await conductor.isConfigured()).toBe(true);
  });
  it("detects concurrent edits even when the planned external settings content is unchanged",async()=>{
    const path=join(home,".conductor/settings.toml");await conductor.configure(options());const selected=readFileSync(path,"utf8"),before=contents();
    mocks.beforeRename=(to)=>{if(to===join(managed,"catalog.json")){mocks.beforeRename=undefined;writeFileSync(path,selected+"# parallel edit\n");}};
    await expect(conductor.configure({...options(),modelKinds:"all"})).rejects.toThrow(/changed during setup/);
    expect(readFileSync(path,"utf8")).toBe(selected+"# parallel edit\n");expect(contents()).toEqual(before);
  });
  it("upgrades a legacy manual installation without later restoring a dead wrapper path",async()=>{
    const path=join(home,".conductor/settings.toml");await conductor.configure(options());
    const statePath=join(managed,"state.json"),state=JSON.parse(readFileSync(statePath,"utf8"));delete state.files["settings.json"];writeFileSync(statePath,JSON.stringify(state));rmSync(join(managed,"settings.json"));
    await conductor.configure(options());await conductor.unconfigure();expect(readDesktopConfig(readFileSync(path,"utf8"))).toEqual({codex_provider:"default"});
  });
  it("reclaims an expired setup lease after its owner is killed",async()=>{
    const owner=await holdSetupLock();await stopSetupLockOwner(owner);
    const lockPath=join(home,".opper/.conductor.lock"),expired=new Date(Date.now()-20000);utimesSync(lockPath,expired,expired);
    await conductor.configure(options());expect(await conductor.isConfigured()).toBe(true);expect(existsSync(lockPath)).toBe(false);
  });
  it("does not steal an active owner's renewed lease beyond the stale interval",async()=>{
    const owner=await holdSetupLock(),lockPath=join(home,".opper/.conductor.lock"),initial=statSync(lockPath);
    try {
      await new Promise(resolve=>setTimeout(resolve,11000));expect(statSync(lockPath).mtimeMs).toBeGreaterThan(initial.mtimeMs+6000);
      await expect(conductor.configure(options())).rejects.toMatchObject({code:"AGENT_CONFIG_CONFLICT"});
      expect(statSync(lockPath).ino).toBe(initial.ino);expect(existsSync(managed)).toBe(false);
    } finally {await stopSetupLockOwner(owner);}
  },20000);
  it("does not report successful removal while a first install owns the lease before creating its directory",async()=>{
    const owner=await holdSetupLock();
    try {expect(existsSync(managed)).toBe(false);await expect(conductor.unconfigure()).rejects.toMatchObject({code:"AGENT_CONFIG_CONFLICT"});}
    finally {await stopSetupLockOwner(owner);}
    const lockPath=join(home,".opper/.conductor.lock"),expired=new Date(Date.now()-20000);utimesSync(lockPath,expired,expired);
    await conductor.unconfigure();expect(existsSync(lockPath)).toBe(false);
  });
  it("preserves symlinked or non-directory setup lock paths",async()=>{
    const path=join(home,".opper/.conductor.lock"),target=join(home,"personal-lock");mkdirSync(target);symlinkSync(target,path);
    await expect(conductor.configure(options())).rejects.toMatchObject({code:"AGENT_CONFIG_CONFLICT"});expect(existsSync(target)).toBe(true);
    rmSync(path);writeFileSync(path,"user content");await expect(conductor.unconfigure()).rejects.toMatchObject({code:"AGENT_CONFIG_CONFLICT"});expect(readFileSync(path,"utf8")).toBe("user content");
  });
});
