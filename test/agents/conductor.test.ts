import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { setSlot, deleteSlot } from "../../src/auth/config.js";
import { readDesktopConfig } from "../../src/setup/codex-desktop-config.js";

const mocks = vi.hoisted(() => ({ home: "", platform: "darwin", run: vi.fn(), catalog: vi.fn(), failRename: "" }));
vi.mock("node:os", async () => ({ ...await vi.importActual<typeof import("node:os")>("node:os"), homedir: () => mocks.home, platform: () => mocks.platform }));
vi.mock("../../src/util/run.js", () => ({ run: mocks.run }));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {...actual, rename: async (from: string, to: string) => {
    if (to === mocks.failRename) {mocks.failRename="";throw new Error("synthetic mid-write failure");}
    return actual.rename(from,to);
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
  writeFileSync(target, `#!${process.execPath}\nif (process.argv.includes('--version')) console.log('codex-cli ${version}'); else console.log(JSON.stringify(process.argv.slice(2)));\n`, {mode: 0o700});
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

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "opper conductor "));mocks.home=home;managed=join(home,".opper/conductor");
  mocks.platform="darwin";mocks.failRename="";vi.stubEnv("OPPER_HOME", join(home,".opper"));vi.stubEnv("OPPER_API_KEY", undefined);vi.stubEnv("OPPER_BASE_URL", undefined);vi.stubEnv("OPPER_DISTRIBUTION", undefined);
  mocks.run.mockReset();mocks.run.mockImplementation((cmd: string) => ({code: 0,stdout: cmd.endsWith("plutil") ? "com.conductor.app" : "codex-cli 0.162.1",stderr:""}));
  mocks.catalog.mockReset();mocks.catalog.mockImplementation(async (_context, selected, kinds) => toConductorModelCatalog([{id:model,opper:{kind:"dynamic_route",capabilities:["tools"]}},{id:"synthetic/extra",opper:{kind:"model",type:"llm",capabilities:["tools"]}}],selected,kinds));
  await setSlot("test",{apiKey:key,baseUrl:host,orgId:42});runtime();vi.spyOn(console,"log").mockImplementation(()=>{});
});
afterEach(()=>{process.execPath=originalExecPath;vi.unstubAllEnvs();vi.restoreAllMocks();rmSync(home,{recursive:true,force:true});});

describe.skipIf(process.platform === "win32")("Conductor Codex integration",()=>{
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
    await conductor.configure(options());const original=contents();await conductor.configure(options());expect(contents()).toEqual(original);
    writeFileSync(join(managed,"personal.txt"),"keep");await conductor.unconfigure();expect(readdirSync(managed)).toEqual(["personal.txt"]);expect(await conductor.isConfigured()).toBe(false);await conductor.unconfigure();
  });
  it("expands and narrows provider discovery while preserving an explicit deployment",async()=>{
    const ids=()=>JSON.parse(readFileSync(join(managed,"catalog.json"),"utf8")).models.map((entry:{slug:string})=>entry.slug);
    await conductor.configure({...options(),modelKinds:"all"});expect(ids()).toEqual([model,"synthetic/extra"]);
    await conductor.configure(options());expect(ids()).toEqual([model]);
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
    await conductor.configure(options());const before=contents();mocks.failRename=join(managed,"catalog.json");await expect(conductor.configure(options())).rejects.toThrow("synthetic mid-write failure");expect(contents()).toEqual(before);expect(await conductor.isConfigured()).toBe(true);
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
});
