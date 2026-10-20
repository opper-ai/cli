import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  installOpenCodeLoginBridge,
  removeOpenCodeLoginBridge,
  openCodeLoginBridgePath,
} from "../../src/setup/opencode-login-bridge.js";

let home: string;
let previous: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "opper-bridge-"));
  previous = process.env.OPPER_EDITOR_HOME;
  process.env.OPPER_EDITOR_HOME = home;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (previous === undefined) delete process.env.OPPER_EDITOR_HOME;
  else process.env.OPPER_EDITOR_HOME = previous;
  await rm(home, { recursive: true, force: true });
});

describe("OpenCode login bridge setup", () => {
  it("refreshes an old managed copy and loads central labels from the installed plugin", async () => {
    const path = openCodeLoginBridgePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "// Managed by @opperai/cli.\nexport const OpperLoginPlugin = async () => ({});\n");
    await installOpenCodeLoginBridge("work");
    const source = await readFile(path, "utf8");
    expect(source).toContain('const DEFAULT_SLOT = "work";');
    expect(source).toContain("Variable pricing");
    vi.stubEnv("OPPER_API_KEY", "synthetic");
    vi.stubEnv("OPPER_BASE_URL", "https://example.invalid");
    vi.stubEnv("OPPER_PROJECT_UUID", "");
    vi.stubEnv("OPPER_CLI_LAUNCH_OPENCODE", "0");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [{
      id: "dynamic/team", opper: { kind: "dynamic_route", display_name: "Work Smart v2", pricing: { kind: "variable" } },
    }] })));
    const installed = await import(pathToFileURL(path).href);
    const config: Record<string, any> = {};
    await (await installed.OpperLoginPlugin()).config(config);
    expect(config.provider.opper.models["dynamic/team"].name).toBe("Work Smart v2 (route) · Variable pricing");
  });
  it("installs one managed global plugin without writing an API key or provider config", async () => {
    const result = await installOpenCodeLoginBridge();
    const file = await readFile(result.path, "utf8");
    expect(result.path).toBe(openCodeLoginBridgePath());
    expect(file).toContain("OpperLoginPlugin");
    expect(file).not.toContain("op_live_");
    await expect(readFile(join(home, ".config", "opencode", "opencode.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await removeOpenCodeLoginBridge()).toBe(true);
    await expect(readFile(result.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("binds the installed plugin to the selected CLI slot without storing a secret", async () => {
    const result = await installOpenCodeLoginBridge("finnova");
    const file = await readFile(result.path, "utf8");
    expect(file).toContain('const DEFAULT_SLOT = "finnova";');
    expect(file).toContain("process.env.OPPER_KEY_SLOT || DEFAULT_SLOT");
    expect(file).not.toContain("op_live_");
  });

  it("persists only an explicitly chosen target alongside the slot name", async () => {
    const projectUuid = "11111111-1111-4111-8111-111111111111";
    const result = await installOpenCodeLoginBridge("org-personal", projectUuid);
    const file = await readFile(result.path, "utf8");
    expect(file).toContain(`const DEFAULT_PROJECT_UUID = "${projectUuid}";`);
    expect(file).toContain('const DEFAULT_SLOT = "org-personal";');
    expect(file).not.toContain("op_live_");
  });

  it("refuses to overwrite or remove a plugin file that the CLI does not own", async () => {
    const path = openCodeLoginBridgePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "export const CustomPlugin = async () => ({});\n");
    await expect(installOpenCodeLoginBridge()).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    await expect(removeOpenCodeLoginBridge()).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    expect(await readFile(path, "utf8")).toContain("CustomPlugin");
  });
});

it("uses narrow native-plugin fallback for fresh setup and retains configured or selected deployments", async () => {
  const installed = await installOpenCodeLoginBridge();
  expect(await readFile(installed.path, "utf8")).toContain('const DEFAULT_MODEL_KINDS = "pools,routes";');
  vi.stubEnv("OPPER_API_KEY", "synthetic"); vi.stubEnv("OPPER_CLI_LAUNCH_OPENCODE", "0");
  const entries = [
    {id:"vendor/new",opper:{kind:"model"}}, {id:"pool",opper:{kind:"pool"}},
    {id:"dynamic/team",opper:{kind:"dynamic_route"}}, {id:"vendor/saved",opper:{kind:"model"}},
  ].map(entry=>({...entry,pricing:{prompt:"0.000001",completion:"0.000002"},opper:{...entry.opper,type:"llm",capabilities:["tools"]}}));
  vi.stubGlobal("fetch",vi.fn().mockImplementation(()=>Promise.resolve(Response.json({data:entries}))));
  const plugin=await import(pathToFileURL(installed.path).href);
  const fresh: any={}; await (await plugin.OpperLoginPlugin()).config(fresh);
  expect(fresh.provider.opper.whitelist).toEqual(["dynamic/team","pool"]);
  const upgrade: any={model:"opper/vendor/saved",agent:{plan:{model:"opper/vendor/saved"}},provider:{opper:{models:{"vendor/new":{},"vendor/denied":{}}}}};
  await (await plugin.OpperLoginPlugin()).config(upgrade);
  expect(upgrade.provider.opper.whitelist).toEqual(["dynamic/team","pool","vendor/new","vendor/saved"]);
  expect(upgrade.model).toBe("opper/vendor/saved"); expect(upgrade.agent.plan.model).toBe("opper/vendor/saved");
  await installOpenCodeLoginBridge("default",undefined,"all");
  expect(await readFile(installed.path,"utf8")).toContain('const DEFAULT_MODEL_KINDS = "all";');
  await installOpenCodeLoginBridge();
  expect(await readFile(installed.path,"utf8")).toContain('const DEFAULT_MODEL_KINDS = "all";');
});
