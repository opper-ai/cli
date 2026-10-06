import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const whichMock = vi.fn();
const runMock = vi.fn();
vi.mock("../../src/util/which.js", () => ({ which: whichMock }));
vi.mock("../../src/util/run.js", () => ({ run: runMock }));

const { pi } = await import("../../src/agents/pi.js");

const SESSION_URL =
  "https://api.opper.ai/v3/session/sess_aa11bb22-cccc-4ddd-8eee-ffff00001111/customer:acme";

const ROUTING = {
  apiBaseUrl: "https://api.opper.ai",
  baseUrl: SESSION_URL,
  apiKey: "op_live_run",
  model: "claude-opus-4-7",
  compatShape: "openai" as const,
};

function agentDir(sandbox: string): string {
  return join(sandbox, ".pi", "agent");
}
function modelsPath(sandbox: string): string {
  return join(agentDir(sandbox), "models.json");
}
function extPath(sandbox: string): string {
  return join(agentDir(sandbox), "extensions", "opper-session.ts");
}
function readModels(sandbox: string): {
  providers?: Record<string, { baseUrl?: string; apiKey?: string; headers?: unknown }>;
} {
  return JSON.parse(readFileSync(modelsPath(sandbox), "utf8"));
}

describe("pi adapter", () => {
  let sandbox: string;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(Response.json({data: ["claude-opus-4-7", "dynamic/coding", "provider/new-model"].map(id => ({id, context_length:128000, opper:{capabilities:["tools"],max_output_tokens:4096}}))}))));
    whichMock.mockReset();
    runMock.mockReset();
    whichMock.mockResolvedValue("/usr/bin/pi");
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === "--version") return { code: 0, stdout: "pi 0.79.4" };
      return { code: 0, stdout: "" };
    });
    sandbox = mkdtempSync(join(tmpdir(), "opper-pi-"));
    // node:os.homedir() reads USERPROFILE on Windows and HOME on POSIX.
    vi.stubEnv("HOME", sandbox);
    vi.stubEnv("USERPROFILE", sandbox);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(sandbox, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("metadata is correct", () => {
    expect(pi.name).toBe("pi");
    expect(pi.displayName).toBe("Pi");
    expect(typeof pi.spawn).toBe("function");
    expect(typeof pi.install).toBe("function");
  });

  it("configure (no apiKey) throws AUTH_REQUIRED", async () => {
    await expect(pi.configure({})).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("configure with apiKey writes the default compat URL into the real models.json", async () => {
    await pi.configure({ apiKey: "op_live_test" });
    const models = readModels(sandbox);
    expect(models.providers?.opper?.baseUrl).toBe("https://api.opper.ai/v3/compat");
    expect(models.providers?.opper?.apiKey).toBe("${OPPER_API_KEY}");
    expect(JSON.stringify(models)).not.toContain("op_live_test");
    // No static trace headers — those are added per session by the extension.
    expect(models.providers?.opper?.headers).toBeUndefined();
  });

  it("uses legacy env references for the legacy Pi release installed by the adapter", async () => {
    runMock.mockImplementation((_cmd: string, args: string[]) => ({code:0,stdout:args[0] === "--version" ? "0.73.1" : ""}));
    await pi.configure({apiKey:"synthetic-legacy"});
    expect(readModels(sandbox).providers?.opper?.apiKey).toBe("OPPER_API_KEY");
    expect(readFileSync(modelsPath(sandbox), "utf8")).not.toContain("synthetic-legacy");
  });

  it.each([["0.76.0", "OPPER_API_KEY"], ["0.77.0", "${OPPER_API_KEY}"], ["1.0.3", "${OPPER_API_KEY}"]])("resolves environment syntax for Pi %s", async (version, reference) => {
    runMock.mockImplementation((_cmd: string, args: string[]) => ({code:0,stdout:args[0] === "--version" ? version : ""}));
    await pi.configure({apiKey:"synthetic"});
    expect(readModels(sandbox).providers?.opper?.apiKey).toBe(reference);
  });

  it("uses explicit env interpolation when the Pi version is unknown", async () => {
    whichMock.mockResolvedValue(undefined);
    await pi.configure({apiKey:"synthetic"});
    expect(readModels(sandbox).providers?.opper?.apiKey).toBe("${OPPER_API_KEY}");
  });

  it("detects legacy Pi versions written to stderr", async () => {
    runMock.mockImplementation((_cmd: string, args: string[]) => ({code:0,stdout:"",stderr:args[0] === "--version" ? "0.73.1\n" : ""}));
    expect(await pi.detect()).toMatchObject({version:"0.73.1"});
    await pi.configure({apiKey:"synthetic"});
    expect(readModels(sandbox).providers?.opper?.apiKey).toBe("OPPER_API_KEY");
  });

  it.each([["0.80.5", "max"], ["0.80.6", null]])("maps maximum effort for Pi %s", async (version, xhigh) => {
    runMock.mockImplementation((_cmd: string, args: string[]) => ({code:0,stdout:args[0] === "--version" ? version : ""}));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({data:[{id:"fixture",context_length:128000,opper:{capabilities:["tools"],max_output_tokens:4096,reasoning:{supported:["max"]}}}]})));
    await pi.configure({apiKey:"synthetic"});
    const provider = readModels(sandbox).providers?.opper as any;
    expect(provider.models[0].thinkingLevelMap.xhigh).toBe(xhigh);
  });

  it("preserves existing provider when configure catalog authorization fails", async () => {
    await pi.configure({apiKey:"synthetic"});
    const before = readFileSync(modelsPath(sandbox), "utf8");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({error:{message:"Denied"}},{status:403})));
    await expect(pi.configure({apiKey:"synthetic-invalid"})).rejects.toThrow();
    expect(readFileSync(modelsPath(sandbox), "utf8")).toBe(before);
  });

  it("spawn writes the session URL AND ships the extension mid-launch", async () => {
    let mid: { models: ReturnType<typeof readModels>; extExists: boolean; ext: string } | undefined;
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === "--version") return { code: 0, stdout: "pi 0.79.4" };
      mid = {
        models: readModels(sandbox),
        extExists: existsSync(extPath(sandbox)),
        ext: existsSync(extPath(sandbox)) ? readFileSync(extPath(sandbox), "utf8") : "",
      };
      return { code: 0, stdout: "" };
    });

    const code = await pi.spawn!([], ROUTING);
    expect(code).toBe(0);
    expect(mid?.models.providers?.opper?.baseUrl).toBe(SESSION_URL);
    expect((mid?.models.providers?.opper as any)?.authHeader).toBe(true);
    expect((mid?.models.providers?.opper as any)?.models.map((m: any) => m.id)).toEqual(["claude-opus-4-7", "dynamic/coding", "provider/new-model"]);
    // The real key is never written to disk — only the env reference is.
    expect(mid?.models.providers?.opper?.apiKey).toBe("${OPPER_API_KEY}");
    expect(JSON.stringify(mid?.models)).not.toContain("op_live_run");
    expect(mid?.extExists).toBe(true);
    expect(mid?.ext).toContain("session_start");
    expect(mid?.ext).toContain("registerProvider");
    expect(mid?.ext).toContain("X-Opper-Trace-Id");
  });

  it("spawn runs pi against the real home with key + base url in the env", async () => {
    await pi.spawn!([], ROUTING);
    const call = runMock.mock.calls.find((c) => c[0] === "pi" && c[1]?.[0] !== "--version");
    const [, args, opts] = call!;
    expect(args).toEqual(["--provider", "opper", "--model", "claude-opus-4-7"]);
    expect(opts.inherit).toBe(true);
    expect(opts.env.OPPER_API_KEY).toBe("op_live_run");
    expect(opts.env.OPPER_BASE_URL).toBe(SESSION_URL);
    // We do NOT isolate — no PI_CODING_AGENT_DIR override.
    expect(opts.env.PI_CODING_AGENT_DIR).toBeUndefined();
  });

  it("spawn restores config and removes the extension on exit (one-off launch leaves nothing)", async () => {
    expect(existsSync(modelsPath(sandbox))).toBe(false);
    await pi.spawn!([], ROUTING);
    // No pre-existing config → models.json removed, extension gone.
    expect(existsSync(modelsPath(sandbox))).toBe(false);
    expect(existsSync(extPath(sandbox))).toBe(false);
  });

  it("spawn restores the pre-launch config and a pre-existing extension", async () => {
    await pi.configure({ apiKey: "op_user_key" });
    mkdirSync(join(agentDir(sandbox), "extensions"), { recursive: true });
    writeFileSync(extPath(sandbox), "// user's own extension\n", "utf8");
    const beforeModels = readFileSync(modelsPath(sandbox), "utf8");

    await pi.spawn!([], ROUTING);

    expect(readFileSync(modelsPath(sandbox), "utf8")).toBe(beforeModels);
    expect(readFileSync(extPath(sandbox), "utf8")).toBe("// user's own extension\n");
  });

  it("spawn preserves sibling providers edited mid-launch", async () => {
    await pi.configure({ apiKey: "op_user_key" });
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === "--version") return { code: 0, stdout: "pi 0.79.4" };
      const cur = JSON.parse(readFileSync(modelsPath(sandbox), "utf8")) as {
        providers?: Record<string, unknown>;
      };
      cur.providers = cur.providers ?? {};
      cur.providers["lmstudio"] = { baseUrl: "http://localhost:1234" };
      writeFileSync(modelsPath(sandbox), JSON.stringify(cur, null, 2) + "\n", "utf8");
      return { code: 0, stdout: "" };
    });

    await pi.spawn!([], ROUTING);
    const after = readModels(sandbox);
    expect(after.providers?.lmstudio).toEqual({ baseUrl: "http://localhost:1234" });
    expect(after.providers?.opper?.baseUrl).toBe("https://api.opper.ai/v3/compat");
  });

  it("spawn does not auto-inject --model when the user passes one", async () => {
    await pi.spawn!(["--model", "claude-haiku-4-5"], ROUTING);
    const call = runMock.mock.calls.find((c) => c[0] === "pi" && c[1]?.[0] !== "--version");
    expect(call![1]).toEqual(["--provider", "opper", "--model", "claude-haiku-4-5"]);
  });

  it("keeps existing config and does not launch when the allowed catalog is empty", async () => {
    await pi.configure({apiKey: "synthetic"});
    const before = readFileSync(modelsPath(sandbox), "utf8");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({data: []})));
    await expect(pi.spawn!([], ROUTING)).rejects.toThrow(/No allowed/);
    expect(readFileSync(modelsPath(sandbox), "utf8")).toBe(before);
    expect(runMock.mock.calls.every((call) => call[1]?.[0] === "--version")).toBe(true);
  });

  it("spawn propagates non-zero exit codes", async () => {
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === "--version") return { code: 0, stdout: "pi 0.79.4" };
      return { code: 17, stdout: "" };
    });
    expect(await pi.spawn!([], ROUTING)).toBe(17);
  });

  it("unconfigure removes the opper provider and any leftover extension", async () => {
    await pi.configure({ apiKey: "op_live_test" });
    mkdirSync(join(agentDir(sandbox), "extensions"), { recursive: true });
    writeFileSync(extPath(sandbox), "// leftover\n", "utf8");

    await pi.unconfigure();
    expect(readModels(sandbox).providers?.opper).toBeUndefined();
    expect(existsSync(extPath(sandbox))).toBe(false);
  });
});
