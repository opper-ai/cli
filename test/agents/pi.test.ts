import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseJsoncObject } from "../../src/util/jsonc.js";

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
  return parseJsoncObject(readFileSync(modelsPath(sandbox), "utf8"));
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
    vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
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

  it("installs current Pi with npm engine requirements enforced", async () => {
    await pi.install!();
    expect(runMock).toHaveBeenCalledWith("npm", [
      "install", "-g", "@earendil-works/pi-coding-agent", "--engine-strict", "--force=false",
    ], { inherit: true });
    expect(existsSync(modelsPath(sandbox))).toBe(false);
  });

  it("explains the npm runtime requirement when Pi installation fails", async () => {
    runMock.mockReturnValue({ code: 1, stdout: "", stderr: "" });
    await expect(pi.install!()).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
      hint: expect.stringContaining("Node.js 22.19.0 or later"),
    });
    expect(existsSync(modelsPath(sandbox))).toBe(false);
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

  it("uses legacy env references for an already installed legacy Pi release", async () => {
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

  it("fresh setup narrows the catalog while explicit all restores provider deployments", async () => {
    await pi.configure({ apiKey: "synthetic" });
    const ids = () => (readModels(sandbox).providers?.opper as any).models.map((model: any) => model.id);
    expect(ids()).toEqual(["dynamic/coding", "claude-opus-4-7"]);
    await pi.configure({ apiKey: "synthetic", modelKinds: "all" });
    expect(ids()).toContain("provider/new-model");
    // A later ordinary upgrade preserves models potentially selected by saved sessions.
    await pi.configure({ apiKey: "synthetic" });
    expect(ids()).toContain("provider/new-model");
  });

  it("upgrade keeps authorized provider models and custom settings unchanged", async () => {
    mkdirSync(agentDir(sandbox), { recursive: true });
    writeFileSync(modelsPath(sandbox), JSON.stringify({ providers: { opper: { models: [
      { id: "provider/new-model", samplingParams: { temperature: 0.2 } },
    ] } } }));
    await pi.configure({ apiKey: "synthetic" });
    const provider = readModels(sandbox).providers?.opper as any;
    expect(provider.models.find((model: any) => model.id === "provider/new-model").samplingParams).toEqual({ temperature: 0.2 });
    const before = readFileSync(modelsPath(sandbox), "utf8");
    runMock.mockImplementation((_cmd: string, args: string[], opts: any) => {
      if (args[0] === "--version") return { code: 0, stdout: "1.2.0" };
      expect(JSON.parse(readFileSync(opts.env.OPPER_PI_CATALOG_PATH, "utf8")).some((model: any) => model.id === "provider/new-model")).toBe(true);
      return { code: 0, stdout: "" };
    });
    await pi.spawn!([], ROUTING);
    expect(readFileSync(modelsPath(sandbox), "utf8")).toBe(before);
  });

  it("preserves Pi's saved Opper default in settings during refresh and launch", async () => {
    mkdirSync(agentDir(sandbox), { recursive: true });
    const settingsPath = join(agentDir(sandbox), "settings.json");
    const settings = JSON.stringify({ defaultProvider: "opper", defaultModel: "provider/new-model", theme: "light" });
    writeFileSync(settingsPath, settings);
    await pi.configure({ apiKey: "synthetic" });
    expect((readModels(sandbox).providers?.opper as any).models.some((model: any) => model.id === "provider/new-model")).toBe(true);
    await pi.spawn!([], ROUTING);
    const launch = runMock.mock.calls.find(call => call[1]?.[0] !== "--version");
    expect(launch![1]).toContain("provider/new-model");
    expect(readFileSync(settingsPath, "utf8")).toBe(settings);
    writeFileSync(settingsPath, settings.replace("provider/new-model", "withdrawn"));
    const before = readFileSync(modelsPath(sandbox), "utf8");
    await expect(pi.configure({ apiKey: "synthetic" })).rejects.toThrow(/selected model/);
    await expect(pi.spawn!([], ROUTING)).rejects.toThrow(/selected model/);
    expect(readFileSync(modelsPath(sandbox), "utf8")).toBe(before);
  });

  it("keeps ordinary Opper launch routing when project settings are present", async () => {
    mkdirSync(join(sandbox, ".pi"), { recursive: true });
    writeFileSync(join(sandbox, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "opper", defaultModel: "withdrawn-untrusted" }));
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(sandbox);
    try {
      await pi.configure({ apiKey: "synthetic" });
      expect((readModels(sandbox).providers?.opper as any).models.some((model: any) => model.id === "provider/new-model")).toBe(false);
      runMock.mockImplementation((_cmd: string, args: string[], opts: any) => {
        if (args[0] === "--version") return { code: 0, stdout: "1.2.0" };
        expect(args).toContain("--model");
        expect(args).toContain("--provider");
        expect(args[args.indexOf("--provider") + 1]).toBe("opper");
        return { code: 0, stdout: "" };
      });
      await pi.spawn!(["--no-approve"], ROUTING);
    } finally { cwd.mockRestore(); }
  });

  it("native scoped models override an unavailable saved Pi default", async () => {
    mkdirSync(agentDir(sandbox), { recursive: true });
    writeFileSync(join(agentDir(sandbox), "settings.json"), JSON.stringify({ defaultProvider: "opper", defaultModel: "withdrawn" }));
    await expect(pi.spawn!(["--models", "opper/provider/*"], ROUTING)).resolves.toBe(0);
    const launch = runMock.mock.calls.find(call => call[1]?.[0] !== "--version");
    expect(launch![1]).not.toContain("--model");
    expect(launch![1]).not.toContain("--provider");
  });

  it("explicit Opper provider model stays selected and unavailable selections fail before launch", async () => {
    runMock.mockImplementation((_cmd: string, args: string[], opts: any) => {
      if (args[0] === "--version") return { code: 0, stdout: "1.2.0" };
      expect(args[args.indexOf("--model") + 1]).toBe("provider/new-model");
      expect(JSON.parse(readFileSync(opts.env.OPPER_PI_CATALOG_PATH, "utf8")).some((model: any) => model.id === "provider/new-model")).toBe(true);
      return { code: 0, stdout: "" };
    });
    await pi.spawn!([], { ...ROUTING, model: "provider/new-model", modelOverride: "provider/new-model" });
    runMock.mockClear();
    await expect(pi.spawn!([], { ...ROUTING, model: "provider/withdrawn", modelOverride: "provider/withdrawn" })).rejects.toThrow(/selected model/);
    expect(runMock.mock.calls.every(call => call[1]?.[0] === "--version")).toBe(true);
  });

  it.each([["--model", "provider/new-model"], ["--model=provider/new-model"], ["-m", "provider/new-model"], ["--models", "provider/*"]])("native model arguments preserve full authorized access: %j", async (...args) => {
    runMock.mockImplementation((_cmd: string, launchArgs: string[], opts: any) => {
      if (launchArgs[0] === "--version") return { code: 0, stdout: "1.2.0" };
      expect(JSON.parse(readFileSync(opts.env.OPPER_PI_CATALOG_PATH, "utf8")).some((model: any) => model.id === "provider/new-model")).toBe(true);
      return { code: 0, stdout: "" };
    });
    await pi.spawn!(args, ROUTING);
  });

  it.each(["--continue", "-c", "--resume", "-r", "--session=fixture", "--session", "--fork", "--session-id"]) ("resuming with %s keeps the saved model available without overriding it", async (flag) => {
    runMock.mockImplementation((_cmd: string, args: string[], opts: any) => {
      if (args[0] === "--version") return { code: 0, stdout: "1.2.0" };
      expect(args).not.toContain("--model");
      expect(args).not.toContain("--provider");
      expect(JSON.parse(readFileSync(opts.env.OPPER_PI_CATALOG_PATH, "utf8")).some((model: any) => model.id === "provider/new-model")).toBe(true);
      return { code: 0, stdout: "" };
    });
    await pi.spawn!([flag], ROUTING);
  });

  it("spawn supplies its catalog via a private temporary extension without user config writes", async () => {
    let launchDir: string | undefined;
    runMock.mockImplementation((_cmd: string, args: string[], opts: any) => {
      if (args[0] === "--version") return { code: 0, stdout: "1.3.0" };
      const extension = args[args.indexOf("--extension") + 1]!;
      const catalogPath = opts.env.OPPER_PI_CATALOG_PATH;
      launchDir = join(extension, "..");
      expect(args).toContain("--extension");
      expect(readFileSync(extension, "utf8")).toContain("registerProvider");
      expect(JSON.parse(readFileSync(catalogPath, "utf8")).map((m: any) => m.id)).toEqual(["dynamic/coding", "claude-opus-4-7"]);
      expect(readFileSync(catalogPath, "utf8")).not.toContain(ROUTING.apiKey);
      if (process.platform !== "win32") {
        expect(statSync(catalogPath).mode & 0o777).toBe(0o600);
        expect(statSync(launchDir).mode & 0o777).toBe(0o700);
      }
      expect(existsSync(modelsPath(sandbox))).toBe(false);
      expect(existsSync(extPath(sandbox))).toBe(false);
      return { code: 0, stdout: "" };
    });
    expect(await pi.spawn!([], ROUTING)).toBe(0);
    expect(existsSync(launchDir!)).toBe(false);
    expect(existsSync(agentDir(sandbox))).toBe(false);
  });

  it("spawn runs pi against the real home with key + base url in the env", async () => {
    await pi.spawn!([], ROUTING);
    const call = runMock.mock.calls.find((c) => c[0] === "pi" && c[1]?.[0] !== "--version");
    const [, args, opts] = call!;
    expect(args).toEqual(["--provider", "opper", "--model", "claude-opus-4-7", "--extension", expect.any(String)]);
    expect(opts.inherit).toBe(true);
    expect(opts.env.OPPER_API_KEY).toBe("op_live_run");
    expect(opts.env.OPPER_BASE_URL).toBe(SESSION_URL);
    // We do NOT isolate — no PI_CODING_AGENT_DIR override.
    expect(opts.env.PI_CODING_AGENT_DIR).toBeUndefined();
  });

  it("one-off spawn leaves user config and discovered extensions absent", async () => {
    expect(existsSync(modelsPath(sandbox))).toBe(false);
    await pi.spawn!([], ROUTING);
    // No pre-existing config or discovered extension is created.
    expect(existsSync(modelsPath(sandbox))).toBe(false);
    expect(existsSync(extPath(sandbox))).toBe(false);
  });

  it("spawn leaves preexisting config and discovered extension unchanged", async () => {
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
    expect(call![1]).toEqual(["--provider", "opper", "--extension", expect.any(String), "--model", "claude-haiku-4-5"]);
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

  it("unconfigure removes only the opper provider and preserves user extension files", async () => {
    await pi.configure({ apiKey: "op_live_test" });
    mkdirSync(join(agentDir(sandbox), "extensions"), { recursive: true });
    writeFileSync(extPath(sandbox), "// leftover\n", "utf8");

    await pi.unconfigure();
    expect(readModels(sandbox).providers?.opper).toBeUndefined();
    expect(readFileSync(extPath(sandbox), "utf8")).toBe("// leftover\n");
  });

  it("configure and unconfigure preserve JSONC comments and unrelated values", async () => {
    mkdirSync(agentDir(sandbox), { recursive: true });
    const original = `{
      // keep user settings
      "custom": { "enabled": true, },
      "providers": {
        // keep local provider
        "local": { "baseUrl": "http://localhost:1234" },
      },
    }\n`;
    writeFileSync(modelsPath(sandbox), original, { mode: 0o640 });
    const originalMode = statSync(modelsPath(sandbox)).mode & 0o777;
    await pi.configure({ apiKey: "synthetic-secret" });
    const configured = readFileSync(modelsPath(sandbox), "utf8");
    expect(configured).toContain("// keep user settings");
    expect(configured).toContain("// keep local provider");
    expect(readModels(sandbox).providers?.local).toEqual({ baseUrl: "http://localhost:1234" });
    expect(parseJsoncObject(configured).custom).toEqual({ enabled: true });
    expect(configured).not.toContain("synthetic-secret");
    expect(await pi.isConfigured()).toBe(true);
    await pi.configure({ apiKey: "synthetic-secret" });
    expect(readFileSync(modelsPath(sandbox), "utf8")).toBe(configured);
    await pi.unconfigure();
    const after = readFileSync(modelsPath(sandbox), "utf8");
    expect(after).toContain("// keep user settings");
    expect(after).toContain("// keep local provider");
    expect(parseJsoncObject(after)).toEqual(parseJsoncObject(original));
    expect(statSync(modelsPath(sandbox)).mode & 0o777).toBe(originalMode);
    expect(await pi.isConfigured()).toBe(false);
  });

  it.each([
    "{ broken", "[]", "null", '"root"',
    '{"providers": null}', '{"providers": []}', '{"providers": "invalid"}',
    '{"providers": {}, "providers": {}}',
    '{"providers": {"local": {}, "local": {}}}',
    '{"providers": {"opper": null}}', '{"providers": {"opper": []}}',
  ])("fails closed without changing invalid configuration: %s", async (original) => {
    mkdirSync(join(agentDir(sandbox), "extensions"), { recursive: true });
    writeFileSync(modelsPath(sandbox), original);
    writeFileSync(extPath(sandbox), "// preserve existing extension");
    for (const action of [
      () => pi.configure({ apiKey: "synthetic-secret" }),
      () => pi.unconfigure(),
    ]) {
      await expect(action()).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
      expect(readFileSync(modelsPath(sandbox), "utf8")).toBe(original);
      expect(readFileSync(extPath(sandbox), "utf8")).toBe("// preserve existing extension");
    }
    // Read-only launch preflight also rejects malformed configuration unchanged.
    await expect(pi.spawn!([], ROUTING)).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    expect(runMock.mock.calls.every(call => call[1]?.[0] === "--version")).toBe(true);
    expect(readFileSync(modelsPath(sandbox), "utf8")).toBe(original);
    expect(readFileSync(extPath(sandbox), "utf8")).toBe("// preserve existing extension");
  });

  it("spawn preserves JSONC comments and unrelated changes made during launch", async () => {
    mkdirSync(agentDir(sandbox), { recursive: true });
    writeFileSync(modelsPath(sandbox), `{
      // user settings
      "custom": 1,
      "providers": {
        "opper": { /* user's managed-provider comment */ "baseUrl": "http://original", "models": [] },
        // local provider
        "local": { "baseUrl": "http://localhost" },
      },
    }`);
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "--version") return { code: 0, stdout: "1.3.0" };
      const text = readFileSync(modelsPath(sandbox), "utf8");
      expect(text).toContain("// user settings");
      expect(text).not.toContain(ROUTING.apiKey);
      writeFileSync(modelsPath(sandbox), text.replace('"custom": 1', '"custom": 2'));
      return { code: 0, stdout: "" };
    });
    await pi.spawn!([], ROUTING);
    const text = readFileSync(modelsPath(sandbox), "utf8");
    expect(text).toContain("// user settings");
    expect(text).toContain("// local provider");
    expect(text).toContain("/* user's managed-provider comment */");
    expect(parseJsoncObject(text).custom).toBe(2);
    expect(readModels(sandbox).providers?.opper).toEqual({ baseUrl: "http://original", models: [] });
  });

  it.each(["absolute", "tilde", "file-url"])("honors %s PI_CODING_AGENT_DIR for configure, launch and unconfigure", async (kind) => {
    const customDir = join(sandbox, "custom-agent");
    vi.stubEnv("PI_CODING_AGENT_DIR", kind === "tilde" ? "~/custom-agent" : kind === "file-url" ? pathToFileURL(customDir).href : customDir);
    const config = join(customDir, "models.json");
    const extension = join(customDir, "extensions", "opper-session.ts");
    expect((await pi.detect()).configPath).toBe(config);
    await pi.configure({ apiKey: "synthetic-secret" });
    expect(await pi.isConfigured()).toBe(true);
    const before = readFileSync(config, "utf8");
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "--version") return { code: 0, stdout: "1.3.0" };
      expect(existsSync(extension)).toBe(false);
      expect(readFileSync(config, "utf8")).toBe(before);
      return { code: 0, stdout: "" };
    });
    await pi.spawn!([], ROUTING);
    expect(readFileSync(config, "utf8")).toBe(before);
    expect(existsSync(extension)).toBe(false);
    expect(existsSync(modelsPath(sandbox))).toBe(false);
    await pi.unconfigure();
    expect(await pi.isConfigured()).toBe(false);
  });

  it.runIf(process.platform === "win32").each(["/c/pi-agent", "/mnt/c/pi-agent", "/cygdrive/c/pi-agent"])("normalizes Windows shell config path %s like Pi", async (directory) => {
    vi.stubEnv("PI_CODING_AGENT_DIR", directory);
    expect((await pi.detect()).configPath).toBe("C:\\pi-agent\\models.json");
  });

  it("does not remove an unrelated extension created during launch", async () => {
    const sibling = join(agentDir(sandbox), "extensions", "user-added.ts");
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "--version") return { code: 0, stdout: "1.3.0" };
      mkdirSync(join(agentDir(sandbox), "extensions"), { recursive: true });
      writeFileSync(sibling, "// keep new extension");
      return { code: 17, stdout: "" };
    });
    expect(await pi.spawn!([], ROUTING)).toBe(17);
    expect(readFileSync(sibling, "utf8")).toBe("// keep new extension");
    expect(existsSync(extPath(sandbox))).toBe(false);
  });

  it("preserves preexisting extension contents and mode after a launch error", async () => {
    mkdirSync(join(agentDir(sandbox), "extensions"), { recursive: true });
    writeFileSync(extPath(sandbox), "// user's own extension\n");
    chmodSync(extPath(sandbox), 0o600);
    const originalMode = statSync(extPath(sandbox)).mode & 0o777;
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "--version") return { code: 0, stdout: "1.3.0" };
      expect(readFileSync(extPath(sandbox), "utf8")).toBe("// user's own extension\n");
      expect(statSync(extPath(sandbox)).mode & 0o777).toBe(originalMode);
      throw new Error("synthetic launch failure");
    });
    await expect(pi.spawn!([], ROUTING)).rejects.toThrow("synthetic launch failure");
    expect(readFileSync(extPath(sandbox), "utf8")).toBe("// user's own extension\n");
    expect(statSync(extPath(sandbox)).mode & 0o777).toBe(originalMode);
    expect(existsSync(modelsPath(sandbox))).toBe(false);
  });


  it.skipIf(process.platform === "win32")("launch leaves symlinked config and extension targets unchanged", async () => {
    mkdirSync(join(agentDir(sandbox), "extensions"), { recursive: true });
    const configTarget = join(sandbox, "shared-models.json");
    const extensionTarget = join(sandbox, "shared-extension.ts");
    const original = '{/* keep exact */ "providers":{"opper":{"models":[]}}}';
    writeFileSync(configTarget, original);
    writeFileSync(extensionTarget, "// shared extension");
    symlinkSync(configTarget, modelsPath(sandbox));
    symlinkSync(extensionTarget, extPath(sandbox));
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "--version") return { code: 0, stdout: "1.3.0" };
      expect(readFileSync(configTarget, "utf8")).toBe(original);
      expect(readFileSync(extensionTarget, "utf8")).toBe("// shared extension");
      return { code: 0, stdout: "" };
    });
    await pi.spawn!([], ROUTING);
    expect(readFileSync(configTarget, "utf8")).toBe(original);
    expect(readFileSync(extensionTarget, "utf8")).toBe("// shared extension");
  });

  it("keeps concurrent launch catalogs separate and removes owned temporary files on failure", async () => {
    const catalogs: string[] = [];
    runMock.mockImplementation((_cmd: string, args: string[], opts: any) => {
      if (args[0] === "--version") return { code: 0, stdout: "1.3.0" };
      const catalog = opts.env.OPPER_PI_CATALOG_PATH;
      catalogs.push(catalog);
      expect(existsSync(catalog)).toBe(true);
      expect(readFileSync(catalog, "utf8")).not.toContain(ROUTING.apiKey);
      if (catalogs.length === 1) throw new Error("synthetic launch failure");
      return { code: 17, stdout: "" };
    });
    const results = await Promise.allSettled([pi.spawn!([], ROUTING), pi.spawn!([], ROUTING)]);
    expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(new Set(catalogs).size).toBe(2);
    for (const catalog of catalogs) expect(existsSync(join(catalog, ".."))).toBe(false);
    expect(existsSync(agentDir(sandbox))).toBe(false);
  });


  it("configure preserves provider options and retained-model custom fields and comments", async () => {
    mkdirSync(agentDir(sandbox), { recursive: true });
    writeFileSync(modelsPath(sandbox), `{
      "providers": { "opper": {
        // keep provider annotation
        "modelOverrides": {
          "claude-opus-4-7": { "samplingParams": { "temperature": 0.2 }, "contextWindow": 64000, "cost": { "input": 3 }, "reasoning": true },
          "not-allowed-yet": { "samplingParams": { "temperature": 0.5 }, "headers": { "X-Opper-Project": "future-project" } }
        },
        "customOption": true,
        "headers": { /* keep custom header */ "X-Custom": "value", "x-opper-project": "old", "X-Opper-Trace-Id": "stale" },
        "models": [{
          "id": "claude-opus-4-7",
          // keep model annotation
          "samplingParams": { "temperature": 0.3 },
          "baseUrl": "https://wrong.example", "api": "wrong-api",
          "cost": { "input": 999 }, "contextWindow": 1,
          "compat": { "supportsStore": false, "supportsReasoningEffort": true },
          "headers": { "X-Custom-Model": "model", "x-opper-project": "stale-model", "x-opper-parent-span-id": "stale" }
        }]
      }}
    }`);
    await pi.configure({ apiKey: "synthetic-secret", projectUuid: "selected-project" });
    const text = readFileSync(modelsPath(sandbox), "utf8");
    const provider = readModels(sandbox).providers?.opper as any;
    expect(text).toContain("// keep provider annotation");
    expect(text).toContain("// keep model annotation");
    expect(text).toContain("/* keep custom header */");
    expect(provider.customOption).toBe(true);
    expect(provider.modelOverrides["claude-opus-4-7"]).toEqual({ samplingParams: { temperature: 0.2 }, contextWindow: 64000, cost: { input: 3 }, reasoning: true });
    expect(provider.modelOverrides["not-allowed-yet"]).toEqual({ samplingParams: { temperature: 0.5 }, headers: { "X-Opper-Project": "future-project" } });
    expect(provider.headers).toEqual({ "X-Custom": "value", "X-Opper-Project": "selected-project" });
    expect(provider.models[0].samplingParams).toEqual({ temperature: 0.3 });
    expect(provider.models[0].baseUrl).toBeUndefined();
    expect(provider.models[0].api).toBeUndefined();
    expect(provider.models[0].contextWindow).toBe(128000);
    expect(provider.models[0].cost.input).toBe(0);
    expect(provider.models[0].compat).toEqual({ supportsStore: false, supportsReasoningEffort: false });
    expect(provider.models[0].headers).toEqual({ "X-Custom-Model": "model" });
    expect(provider.apiKey).toBe("${OPPER_API_KEY}");
    expect(text).not.toContain("synthetic-secret");
    await pi.configure({ apiKey: "synthetic-secret", projectUuid: "selected-project" });
    expect(readFileSync(modelsPath(sandbox), "utf8")).toBe(text);
    await pi.configure({ apiKey: "synthetic-secret" });
    expect((readModels(sandbox).providers?.opper as any).headers).toEqual({ "X-Custom": "value" });
  });

  it("configure removes unavailable model IDs with a notice and retains allowed custom settings", async () => {
    mkdirSync(agentDir(sandbox), { recursive: true });
    writeFileSync(modelsPath(sandbox), `{"providers":{"opper":{"models":[
      {"id":"withdrawn-model","samplingParams":{"temperature":0.1}},
      // keep allowed model
      {"id":"dynamic/coding","samplingParams":{"temperature":0.4}}
    ]}}}`);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await pi.configure({ apiKey: "synthetic-secret" });
      const provider = readModels(sandbox).providers?.opper as any;
      expect(provider.models.map((model: any) => model.id).sort()).toEqual(["claude-opus-4-7", "dynamic/coding"].sort());
      expect(provider.models.find((model: any) => model.id === "dynamic/coding").samplingParams).toEqual({ temperature: 0.4 });
      expect(readFileSync(modelsPath(sandbox), "utf8")).toContain("// keep allowed model");
      expect(output.mock.calls.map(call => call[0]).join("")).toMatch(/removed.*withdrawn-model/i);
    } finally {
      output.mockRestore();
    }
  });

  it.each(["Authorization", "aUtHoRiZaTiOn", "X-API-Key", "api-key"])("configure rejects conflicting %s headers unchanged", async (header) => {
    mkdirSync(agentDir(sandbox), { recursive: true });
    const original = JSON.stringify({ providers: { opper: { headers: { [header]: "synthetic-other-key" }, models: [] } } });
    writeFileSync(modelsPath(sandbox), original);
    await expect(pi.configure({ apiKey: "synthetic-secret" })).rejects.toMatchObject({
      code: "AGENT_CONFIG_CONFLICT",
      hint: expect.stringMatching(/remove.*header/i),
    });
    expect(readFileSync(modelsPath(sandbox), "utf8")).toBe(original);
  });

  it.each([
    { headers: [] }, { headers: { "X-Custom": 1 } }, { models: {} },
    { models: [null] }, { models: [{ id: 1 }] }, { models: [{ id: "same" }, { id: "same" }] },
    { models: [{ id: "claude-opus-4-7", headers: { Authorization: "synthetic-other" } }] },
    { modelOverrides: { "claude-opus-4-7": { headers: { "x-api-key": "synthetic-other" } } } },
  ])("configure fails closed for unsafe provider data %j", async (provider) => {
    mkdirSync(agentDir(sandbox), { recursive: true });
    const original = JSON.stringify({ providers: { opper: provider } });
    writeFileSync(modelsPath(sandbox), original);
    await expect(pi.configure({ apiKey: "synthetic-secret" })).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    expect(readFileSync(modelsPath(sandbox), "utf8")).toBe(original);
  });


  it.each([
    ["provider", "x-opper-project", "other-project", "selected-project"],
    ["provider", "X-Opper-Project", "previous-project", undefined],
    ["model", "X-OPPER-PROJECT", "other-project", "selected-project"],
    ["override", "x-opper-project", "other-project", "selected-project"],
    ["provider", "X-Opper-Trace-Id", "stale", "selected-project"],
    ["model", "x-opper-parent-span-id", "stale", "selected-project"],
    ["override", "Authorization", "synthetic-other-key", "selected-project"],
  ])("launch rejects %s saved %s header without writes or starting Pi", async (location, header, value, projectUuid) => {
    mkdirSync(agentDir(sandbox), { recursive: true });
    const headers = { [header!]: value };
    const provider = location === "provider" ? { headers } : location === "model"
      ? { models: [{ id: "claude-opus-4-7", headers }] }
      : { modelOverrides: { "claude-opus-4-7": { headers } } };
    const original = JSON.stringify({ providers: { opper: provider } });
    writeFileSync(modelsPath(sandbox), original);
    await expect(pi.spawn!([], { ...ROUTING, projectUuid })).rejects.toMatchObject({
      code: "AGENT_CONFIG_CONFLICT", hint: expect.stringMatching(/remove.*header/i),
    });
    expect(readFileSync(modelsPath(sandbox), "utf8")).toBe(original);
    expect(runMock.mock.calls.every(call => call[1]?.[0] === "--version")).toBe(true);
  });

  it("launch accepts matching saved project headers and ignores headers for unrelated models/providers", async () => {
    mkdirSync(agentDir(sandbox), { recursive: true });
    const original = JSON.stringify({ providers: {
      unrelated: { headers: { Authorization: "synthetic-other-provider" } },
      opper: { headers: { "x-opper-project": "selected-project", "X-Custom": "keep" },
        models: [{ id: "withdrawn-id", headers: { Authorization: "synthetic-unavailable" } }],
        modelOverrides: { "withdrawn-id": { headers: { "X-Opper-Project": "not-selected" } } } },
    } });
    writeFileSync(modelsPath(sandbox), original);
    expect(await pi.spawn!([], { ...ROUTING, projectUuid: "selected-project" })).toBe(0);
    expect(readFileSync(modelsPath(sandbox), "utf8")).toBe(original);
  });

});
