import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const { homeMock, runMock } = vi.hoisted(() => ({ homeMock: vi.fn(), runMock: vi.fn() }));
vi.mock("node:os", async () => ({ ...await vi.importActual("node:os"), homedir: homeMock, platform: () => "darwin" }));
vi.mock("../../src/util/run.js", () => ({ run: runMock }));
const { claudeDesktop } = await import("../../src/agents/claude-desktop.js");
const profileID = "727f05c8-a429-43cc-b1c6-36d8883d98b8";
const selected = "provider/claude-sonnet-5";
const apiBase = "https://synthetic.example.invalid";
const rows = ["claude-opus-5", "claude-sonnet-5", selected];

describe("Claude Desktop native gateway discovery", () => {
  let home: string;
  let profilePath: string;
  let ownership: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  const respond = (ids = rows, marker = true) => Response.json({data: ids.map(id => ({id, type:"model", created_at:"2024-01-01T00:00:00Z", display_name:id})), has_more:false}, {
    headers: marker ? {"X-Opper-Model-Catalog":"claude-desktop"} : {},
  });
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "opper-desktop-native-"));
    homeMock.mockReturnValue(home);
    mkdirSync(join(home, "Applications", "Claude.app"), {recursive:true});
    profilePath = join(home,"Library","Application Support","Claude-3p","configLibrary",`${profileID}.json`);
    ownership = join(dirname(dirname(profilePath)), ".opper-gateway-state.json");
    runMock.mockReset();
    runMock.mockImplementation((command: string) => ({code:0,stdout:command === "plutil" ? "2.42304.2" : "",stderr:""}));
    fetchMock = vi.fn().mockImplementation(() => Promise.resolve(respond()));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); rmSync(home,{recursive:true,force:true}); });

  it("uses native discovery on a supported fresh installation after an authenticated profile probe", async () => {
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase});
    const profile = read(profilePath);
    expect(profile.modelDiscoveryEnabled).toBe(true);
    expect(profile.inferenceModels).toBeUndefined();
    expect(profile.inferenceCustomHeaders).toMatchObject({
      "X-Opper-Model-Catalog":"claude-desktop", "X-Opper-Catalog-Model-Kinds":"pools,routes", "X-Opper-Catalog-Selected-Model":"claude-opus-5",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url.toString()).toBe(`${apiBase}/v3/compat/v1/models?limit=1000`);
    expect(init.headers).toMatchObject({Authorization:"Bearer synthetic",...profile.inferenceCustomHeaders});
    expect(await claudeDesktop.isConfigured()).toBe(true);
  });

  it("preserves a legacy provider selection, full catalog access and unrelated settings on upgrade", async () => {
    runMock.mockReturnValue({code:0,stdout:"",stderr:""});
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase});
    const legacy = {...read(profilePath), inferenceModels:[{name:selected}], inferenceCustomHeaders:{"X-Custom":"keep"}, unrelated:true};
    writeFileSync(profilePath,JSON.stringify(legacy));
    runMock.mockImplementation((command:string)=>({code:0,stdout:command==="plutil"?"2.42304.2":"",stderr:""}));
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase});
    const upgraded=read(profilePath);
    expect(upgraded.inferenceModels).toBeUndefined();
    expect(upgraded.inferenceCustomHeaders).toMatchObject({"X-Custom":"keep","X-Opper-Catalog-Model-Kinds":"all","X-Opper-Catalog-Selected-Model":selected});
    expect(upgraded.unrelated).toBe(true);
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase});
    expect(read(profilePath)).toEqual(upgraded);
  });

  it.each([
    {inferenceModels:[{name:selected,labelOverride:"My deployment",maxEffort:"high"}]},
    {inferenceModels:[{name:selected}],modelDiscoveryEnabled:false},
  ])("retains customized lineups and native-discovery opt-outs %j", async prior => {
    mkdirSync(dirname(profilePath),{recursive:true});
    writeFileSync(profilePath,JSON.stringify(prior));
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase});
    expect(read(profilePath).inferenceModels).toEqual(prior.inferenceModels);
    expect(read(profilePath).modelDiscoveryEnabled).not.toBe(true);
    expect(await claudeDesktop.isConfigured()).toBe(true);
  });

  it("preserves exact selected IDs from native string-form legacy model lists", async () => {
    mkdirSync(dirname(profilePath),{recursive:true});
    writeFileSync(profilePath,JSON.stringify({inferenceModels:[selected,"claude-opus-5"]}));
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase});
    expect(read(profilePath).inferenceCustomHeaders["X-Opper-Catalog-Selected-Model"]).toBe(selected);
    expect(read(profilePath).inferenceCustomHeaders["X-Opper-Catalog-Model-Kinds"]).toBe("all");
  });

  it("retains a previous provider selection when a narrow native selection changes", async () => {
    const next="provider/claude-opus-5";
    fetchMock.mockImplementation(()=>Promise.resolve(respond([...rows,next])));
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase,model:selected});
    expect(read(profilePath).inferenceCustomHeaders["X-Opper-Catalog-Model-Kinds"]).toBe("pools,routes");
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase,model:next,modelKinds:"pools,routes"});
    expect(fetchMock.mock.calls.at(-1)![1].headers).toMatchObject({"X-Opper-Catalog-Model-Kinds":"all","X-Opper-Catalog-Selected-Model":next});
    expect(read(profilePath).inferenceCustomHeaders["X-Opper-Catalog-Model-Kinds"]).toBe("all");
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase});
    expect(read(profilePath).inferenceCustomHeaders["X-Opper-Catalog-Model-Kinds"]).toBe("all");
  });

  it("retains full native catalog access when refresh requests narrowing with the same selection", async () => {
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase,model:selected,modelKinds:"all"});
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase,model:selected,modelKinds:"pools,routes"});
    expect(fetchMock.mock.calls.at(-1)![1].headers).toMatchObject({"X-Opper-Catalog-Model-Kinds":"all","X-Opper-Catalog-Selected-Model":selected});
    expect(read(profilePath).inferenceCustomHeaders["X-Opper-Catalog-Model-Kinds"]).toBe("all");
  });

  it("preserves user edits made during catalog discovery and writes no other setup state", async () => {
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase});
    const ownershipBefore=readFileSync(ownership,"utf8");
    const userEdit=JSON.stringify({...read(profilePath),userEdit:"during discovery"});
    fetchMock.mockImplementation(()=>{writeFileSync(profilePath,userEdit);return Promise.resolve(respond());});
    await expect(claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase})).rejects.toThrow(/changed during model discovery/);
    expect(readFileSync(profilePath,"utf8")).toBe(userEdit);
    expect(readFileSync(ownership,"utf8")).toBe(ownershipBefore);
  });

  it("does not replace a user profile created while fresh setup probes the catalog", async () => {
    const userEdit=JSON.stringify({userEdit:"created during discovery"});
    fetchMock.mockImplementation(()=>{mkdirSync(dirname(profilePath),{recursive:true});writeFileSync(profilePath,userEdit);return Promise.resolve(respond());});
    await expect(claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase})).rejects.toThrow(/changed during model discovery/);
    expect(readFileSync(profilePath,"utf8")).toBe(userEdit);
    expect(existsSync(ownership)).toBe(false);
    expect(existsSync(join(dirname(profilePath),"_meta.json"))).toBe(false);
  });

  it("keeps the old list on servers that do not acknowledge the profile", async () => {
    fetchMock.mockImplementation(()=>Promise.resolve(respond(rows,false)));
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase});
    const before=read(profilePath).inferenceModels;
    expect(before.length).toBeGreaterThan(0);
    expect(read(profilePath).modelDiscoveryEnabled).not.toBe(true);
    expect(await claudeDesktop.isConfigured()).toBe(true);
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase});
    expect(read(profilePath).inferenceModels).toEqual(before);
  });

  it("rejects an unavailable selected model even when the server ignores profile headers", async () => {
    fetchMock.mockImplementation(()=>Promise.resolve(respond(["claude-opus-5"],false)));
    await expect(claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase,model:selected})).rejects.toThrow(/selected model/);
    expect(existsSync(profilePath)).toBe(false);
  });

  it("preserves native profiles if the server or app capability can no longer be verified", async () => {
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase});
    const before=readFileSync(profilePath,"utf8");
    fetchMock.mockImplementation(()=>Promise.resolve(respond(rows,false)));
    await expect(claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase})).rejects.toThrow(/no longer acknowledges/);
    expect(readFileSync(profilePath,"utf8")).toBe(before);
    runMock.mockReturnValue({code:0,stdout:"unknown",stderr:""});
    await expect(claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase})).rejects.toThrow(/Cannot verify native/);
    expect(readFileSync(profilePath,"utf8")).toBe(before);
  });

  it.each(["", "1.2581.0", "unknown"])("retains legacy setup without discovery for app version %s", async version => {
    runMock.mockReturnValue({code:0,stdout:version,stderr:""});
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(read(profilePath).inferenceModels.length).toBeGreaterThan(0);
  });

  it.each([401,403,404,500])("rejects HTTP %s before changing existing profiles", async code => {
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase});
    const before=readFileSync(profilePath,"utf8");
    const beforeOwnership=readFileSync(ownership,"utf8");
    fetchMock.mockImplementation(()=>Promise.resolve(Response.json({error:{message:"Denied"}},{status:code})));
    await expect(claudeDesktop.configure({apiKey:"invalid",baseUrl:apiBase})).rejects.toThrow();
    expect(readFileSync(profilePath,"utf8")).toBe(before);
    expect(readFileSync(ownership,"utf8")).toBe(beforeOwnership);
  });

  it("rejects a missing selected deployment and unsafe profile entries before writing", async () => {
    for(const ids of [["claude-opus-5"],[selected,"gpt-5.5"],[selected,"dynamic/claude-sonnet-5"]]) {
      fetchMock.mockImplementation(()=>Promise.resolve(respond(ids)));
      await expect(claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase,model:selected})).rejects.toThrow();
      expect(existsSync(profilePath)).toBe(false);
    }
  });

  it("passes unrelated headers to discovery and rejects conflicting authentication before writes", async () => {
    mkdirSync(dirname(profilePath),{recursive:true});
    writeFileSync(profilePath,JSON.stringify({inferenceCustomHeaders:{"X-Custom":"keep"}}));
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase});
    expect(fetchMock.mock.calls[0]![1].headers).toMatchObject({"X-Custom":"keep"});
    writeFileSync(profilePath,JSON.stringify({...read(profilePath),inferenceCustomHeaders:{Authorization:"synthetic-other"}}));
    const before=readFileSync(profilePath,"utf8");
    await expect(claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase})).rejects.toThrow(/conflicting authentication/);
    expect(readFileSync(profilePath,"utf8")).toBe(before);
  });

  it("probes upstream with the original credential before storing the isolated proxy token", async () => {
    const proxy={baseUrl:"http://127.0.0.1:45752",token:"synthetic-local-token",stateDir:"/synthetic"};
    await claudeDesktop.configure({apiKey:"synthetic-upstream",baseUrl:apiBase,projectUuid:"synthetic-project",desktopProxy:proxy});
    expect(fetchMock.mock.calls[0]![1].headers).toMatchObject({Authorization:"Bearer synthetic-upstream","X-Opper-Project":"synthetic-project"});
    expect(read(profilePath).inferenceGatewayApiKey).toBe(proxy.token);
    expect(readFileSync(profilePath,"utf8")).not.toContain("synthetic-upstream");
  });

  it("persists direct project targeting and removes only the project header it added", async () => {
    mkdirSync(dirname(profilePath),{recursive:true});
    writeFileSync(profilePath,JSON.stringify({inferenceCustomHeaders:{"X-Custom":"keep"}}));
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase,projectUuid:"project-one"});
    expect(read(profilePath).inferenceCustomHeaders).toMatchObject({"X-Opper-Project":"project-one","X-Custom":"keep"});
    expect(fetchMock.mock.calls[0]![1].headers["X-Opper-Project"]).toBe("project-one");
    expect(read(ownership).projectHeader).toBe("X-Opper-Project");
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase,projectUuid:"project-two"});
    expect(read(profilePath).inferenceCustomHeaders["X-Opper-Project"]).toBe("project-two");
    await claudeDesktop.unconfigure();
    expect(read(profilePath).inferenceCustomHeaders).toEqual({"X-Custom":"keep"});
  });

  it("keeps a matching user project header and its casing through configure/remove", async () => {
    mkdirSync(dirname(profilePath),{recursive:true});
    writeFileSync(profilePath,JSON.stringify({inferenceCustomHeaders:{"x-opper-project":"project-user"}}));
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase});
    expect(read(profilePath).inferenceCustomHeaders["x-opper-project"]).toBe("project-user");
    expect(fetchMock.mock.calls[0]![1].headers["X-Opper-Project"]).toBe("project-user");
    expect(fetchMock.mock.calls[0]![1].headers["x-opper-project"]).toBeUndefined();
    expect(read(ownership).projectHeader).toBeUndefined();
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase,projectUuid:"project-user"});
    expect(read(ownership).projectHeader).toBeUndefined();
    await claudeDesktop.unconfigure();
    expect(read(profilePath).inferenceCustomHeaders).toEqual({"x-opper-project":"project-user"});
  });

  it("does not remove an independently changed project header that Opper originally added", async () => {
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase,projectUuid:"project-one"});
    const changed={...read(profilePath),inferenceCustomHeaders:{...read(profilePath).inferenceCustomHeaders,"X-Opper-Project":"user-project"}};
    writeFileSync(profilePath,JSON.stringify(changed));
    const before=readFileSync(profilePath,"utf8");
    expect(await claudeDesktop.isConfigured()).toBe(false);
    await claudeDesktop.unconfigure();
    expect(readFileSync(profilePath,"utf8")).toBe(before);
  });

  it.each([
    {headers:{"X-Opper-Project":"old-project"},projectUuid:"new-project",proxy:false},
    {headers:{"X-Opper-Project":"old-project"},projectUuid:"new-project",proxy:true},
    {headers:{"X-Opper-Project":"old-project"},projectUuid:undefined,proxy:true},
    {headers:{"X-Opper-Project":"one","x-opper-project":"one"},projectUuid:undefined,proxy:false},
  ])("rejects conflicting or duplicate project headers without writes %j", async config => {
    mkdirSync(dirname(profilePath),{recursive:true});
    const before=JSON.stringify({inferenceCustomHeaders:config.headers});
    writeFileSync(profilePath,before);
    await expect(claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase,projectUuid:config.projectUuid,
      ...(config.proxy?{desktopProxy:{baseUrl:"http://127.0.0.1:45752",token:"local",stateDir:"/synthetic"}}:{})})).rejects.toThrow(/project headers?/);
    expect(readFileSync(profilePath,"utf8")).toBe(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not add a client project header when the proxy binds the requested project", async () => {
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase,projectUuid:"proxy-project",desktopProxy:{baseUrl:"http://127.0.0.1:45752",token:"local",stateDir:"/synthetic"}});
    expect(fetchMock.mock.calls[0]![1].headers["X-Opper-Project"]).toBe("proxy-project");
    expect(read(profilePath).inferenceCustomHeaders["X-Opper-Project"]).toBeUndefined();
    expect(read(ownership).projectHeader).toBeUndefined();
  });

  it.each([
    {has_more:undefined}, {has_more:"false"},
    {data:[{id:"claude-opus-5",type:"not-model",display_name:"Opus",created_at:"2024-01-01T00:00:00Z"}]},
    {data:[{id:"claude-opus-5",type:"model",display_name:"Opus"}]},
    {data:[{id:"claude-opus-5",type:"model",display_name:"Opus",created_at:"not-a-date"}]},
    {data:[{id:"claude-opus-5",type:"model",display_name:42,created_at:"2024-01-01T00:00:00Z"}]},
    {has_more:true,last_id:""},
  ])("rejects malformed native Anthropic metadata before writing %j", async override => {
    const body=await respond().json();
    fetchMock.mockImplementation(()=>Promise.resolve(Response.json({...body,...override},{headers:{"X-Opper-Model-Catalog":"claude-desktop"}})));
    await expect(claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase})).rejects.toThrow();
    expect(existsSync(profilePath)).toBe(false);
  });

  it("removes only owned discovery settings and leaves independently changed profiles untouched", async () => {
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase});
    writeFileSync(profilePath,JSON.stringify({...read(profilePath),unrelated:"keep",inferenceCustomHeaders:{...read(profilePath).inferenceCustomHeaders,"X-Custom":"keep"}}));
    expect(await claudeDesktop.isConfigured()).toBe(true);
    await claudeDesktop.unconfigure();
    expect(read(profilePath)).toMatchObject({unrelated:"keep",inferenceCustomHeaders:{"X-Custom":"keep"}});
    expect(read(profilePath).modelDiscoveryEnabled).toBeUndefined();
    expect(read(profilePath).inferenceGatewayApiKey).toBeUndefined();
    await claudeDesktop.configure({apiKey:"synthetic",baseUrl:apiBase});
    writeFileSync(profilePath,JSON.stringify({...read(profilePath),inferenceCustomHeaders:{...read(profilePath).inferenceCustomHeaders,"X-Opper-Catalog-Selected-Model":"claude-another"}}));
    const changed=readFileSync(profilePath,"utf8");
    await claudeDesktop.unconfigure();
    expect(readFileSync(profilePath,"utf8")).toBe(changed);
  });
});
