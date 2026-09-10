import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const whichMock = vi.fn();
vi.mock("../../src/util/which.js", () => ({ which: whichMock }));

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn() }));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: homedirMock };
});

const runMock = vi.fn();
vi.mock("../../src/util/run.js", () => ({ run: runMock }));

const spawnSyncMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return { ...actual, spawnSync: spawnSyncMock };
});

const { codex } = await import("../../src/agents/codex.js");

const SESSION_URL =
  "https://api.opper.ai/v3/session/sess_aa11bb22-cccc-4ddd-8eee-ffff00001111/customer:acme";

const ROUTING = {
  baseUrl: SESSION_URL,
  apiKey: "op_test_selected",
  model: "claude-sonnet-5",
  compatShape: "responses" as const,
};
const LEGACY = [
  "# >>> opper-cli >>>",
  "# Managed by `opper`. Edits between these markers will be overwritten",
  "# the next time you reconfigure Codex via the Opper CLI.",
  "",
  "[model_providers.opper]",
  'name = "Opper"',
  'base_url = "https://api.opper.ai/v3/compat"',
  'env_key = "OPPER_API_KEY"',
  'wire_api = "responses"',
  "",
  "[profiles.opper-opus]",
  'model = "claude-opus-5"',
  'model_provider = "opper"',
  "# <<< opper-cli <<<",
  "",
].join("\n");
const DESKTOP = 'model = "gpt-5.5"\nmodel_provider = "opper-desktop"\n[model_providers.opper-desktop]\nname = "Desktop"\nbase_url = "https://api.opper.ai/v3/compat"\n';

describe("codex adapter", () => {
  let sandbox: string;
  let cfgPath: string;

  beforeEach(() => {
    whichMock.mockReset();
    runMock.mockReset();
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0 });
    sandbox = mkdtempSync(join(tmpdir(), "opper-codex-"));
    homedirMock.mockReturnValue(sandbox);
    cfgPath = join(sandbox, ".codex", "config.toml");
    vi.stubEnv("CODEX_HOME", "");
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function writeConfig(text: string): void {
    mkdirSync(join(sandbox, ".codex"), { recursive: true });
    writeFileSync(cfgPath, text);
  }

  function spawnedArgs(): string[] {
    return spawnSyncMock.mock.calls[0]![1] as string[];
  }

  it("detects only the CLI on PATH and reports its configuration location", async () => {
    whichMock.mockResolvedValue(null);
    expect(await codex.detect()).toEqual({ installed: false });
    expect(await codex.isConfigured()).toBe(false);
    whichMock.mockResolvedValue("/usr/local/bin/codex");
    expect(await codex.detect()).toEqual({ installed: true, configPath: cfgPath });
    expect(await codex.isConfigured()).toBe(true);
  });

  it("respects CODEX_HOME for detection and passes it into the child", async () => {
    const customHome = join(sandbox, "isolated-codex");
    vi.stubEnv("CODEX_HOME", customHome);
    whichMock.mockResolvedValue("/usr/local/bin/codex");
    expect((await codex.detect()).configPath).toBe(join(customHome, "config.toml"));
    await codex.spawn!([], ROUTING);
    expect(spawnSyncMock.mock.calls[0]![2].env.CODEX_HOME).toBe(customHome);
    expect(existsSync(cfgPath)).toBe(false);
  });

  it("needs no persistent configuration to configure or launch", async () => {
    await codex.configure({});
    await codex.spawn!([], ROUTING);
    expect(existsSync(cfgPath)).toBe(false);
  });

  it("launches current Codex without legacy profiles and honors the selected model", async () => {
    await codex.spawn!(["exec", "hello"], ROUTING);
    expect(spawnSyncMock.mock.calls[0]![0]).toBe("codex");
    const args = spawnedArgs();
    expect(args).not.toContain("--profile");
    expect(args.slice(-4)).toEqual(["--model", "claude-sonnet-5", "exec", "hello"]);
    expect(args).toContain('model_provider="opper-cli"');
    expect(args.find((a) => a.startsWith("model_providers.opper-cli="))).toContain(`base_url = "${SESSION_URL}"`);
    expect(args.join(" ")).toContain('wire_api = "responses"');
    expect(args.join(" ")).toContain('env_key = "OPPER_API_KEY"');
    expect(args.join(" ")).toContain("requires_openai_auth = false");
    expect(args.join(" ")).not.toContain(ROUTING.apiKey);
  });

  it("injects the selected credential only into the child", async () => {
    vi.stubEnv("OPPER_API_KEY", "op_test_parent");
    await codex.spawn!([], ROUTING);
    expect(spawnSyncMock.mock.calls[0]![2].env.OPPER_API_KEY).toBe(ROUTING.apiKey);
    expect(process.env.OPPER_API_KEY).toBe("op_test_parent");
  });

  it("disables unsupported cached web search only for this invocation", async () => {
    const before = 'web_search = "cached"\n' + DESKTOP;
    writeConfig(before);
    await codex.spawn!(["exec", "hello"], ROUTING);
    expect(spawnedArgs()).toContain('web_search="disabled"');
    expect(readFileSync(cfgPath, "utf8")).toBe(before);
  });

  it.each([
    ["--model", "gpt-5.5"],
    ["--model=gpt-5.5"],
    ["-m", "gpt-5.5"],
    ["-mgpt-5.5"],
    ["--profile", "work"],
    ["--profile=work"],
    ["-p", "work"],
    ["-pwork"],
    ["-c", 'model="gpt-5.5"'],
    ["--config=model=\"gpt-5.5\""],
  ])("preserves explicit native model/profile selection: %j", async (...args: string[]) => {
    await codex.spawn!(args, ROUTING);
    expect(spawnedArgs().slice(-args.length)).toEqual(args);
    expect(spawnedArgs()).not.toContain(ROUTING.model);
    expect(spawnedArgs()).toContain('model_provider="opper-cli"');
  });

  it("does not treat prompt text after -- as model flags", async () => {
    await codex.spawn!(["exec", "--", "--model"], ROUTING);
    expect(spawnedArgs()).toContain(ROUTING.model);
  });

  it.each([0, 17])("leaves desktop defaults and legacy profiles unchanged during and after exit %d", async (exitCode) => {
    const before = DESKTOP + LEGACY;
    writeConfig(before);
    await codex.configure({});
    expect(readFileSync(cfgPath, "utf8")).toBe(before);
    spawnSyncMock.mockImplementation(() => {
      expect(readFileSync(cfgPath, "utf8")).toBe(before);
      return { status: exitCode };
    });
    expect(await codex.spawn!([], ROUTING)).toBe(exitCode);
    expect(readFileSync(cfgPath, "utf8")).toBe(before);
  });

  it("preserves concurrent configuration edits without a restore overwrite", async () => {
    writeConfig(DESKTOP + LEGACY);
    spawnSyncMock.mockImplementation(() => {
      writeFileSync(cfgPath, DESKTOP.replace("gpt-5.5", "gpt-5.6") + LEGACY);
      return { status: 0 };
    });
    await codex.spawn!([], ROUTING);
    expect(readFileSync(cfgPath, "utf8")).toBe(DESKTOP.replace("gpt-5.5", "gpt-5.6") + LEGACY);
  });

  it("keeps configuration intact if the child cannot spawn", async () => {
    writeConfig(DESKTOP);
    spawnSyncMock.mockReturnValue({ status: null, error: new Error("spawn failed") });
    expect(await codex.spawn!([], ROUTING)).toBe(-1);
    expect(readFileSync(cfgPath, "utf8")).toBe(DESKTOP);
  });

  it("removes only the old managed CLI block without changing desktop settings", async () => {
    writeConfig(DESKTOP + LEGACY + '# User note\n');
    await codex.unconfigure();
    expect(readFileSync(cfgPath, "utf8")).toBe(DESKTOP + '# User note\n');
    await codex.unconfigure();
    expect(readFileSync(cfgPath, "utf8")).toBe(DESKTOP + '# User note\n');
  });

  it("removes legacy settings only from the selected CODEX_HOME", async () => {
    writeConfig(DESKTOP + LEGACY);
    const customHome = join(sandbox, "isolated-codex");
    mkdirSync(customHome);
    const otherPath = join(customHome, "config.toml");
    writeFileSync(otherPath, LEGACY);
    vi.stubEnv("CODEX_HOME", customHome);
    await codex.unconfigure();
    expect(readFileSync(otherPath, "utf8")).toBe("");
    expect(readFileSync(cfgPath, "utf8")).toBe(DESKTOP + LEGACY);
  });

  it.each([
    '# >>> opper-cli >>>\n# incomplete\n' + DESKTOP,
    '# >>> opper-cli >>>\n' + DESKTOP + LEGACY,
    LEGACY.replace("# <<< opper-cli <<<", '[settings]\ntheme="dark"\n# <<< opper-cli <<<'),
    LEGACY.replace('env_key = "OPPER_API_KEY"', 'env_key = "MY_KEY"'),
  ])("preserves ambiguous legacy configuration on remove", async (text) => {
    writeConfig(text);
    await codex.unconfigure();
    expect(readFileSync(cfgPath, "utf8")).toBe(text);
  });

  it("does not create configuration on remove when absent", async () => {
    await codex.unconfigure();
    expect(existsSync(cfgPath)).toBe(false);
  });

  it("installs the Codex CLI through npm", async () => {
    whichMock.mockResolvedValue("/usr/bin/npm");
    runMock.mockReturnValue({ code: 0, stdout: "", stderr: "" });
    await codex.install!();
    expect(runMock.mock.calls[0]![1]).toEqual(["install", "-g", "@openai/codex"]);
  });

  it("reports failed installation", async () => {
    whichMock.mockResolvedValue("/usr/bin/npm");
    runMock.mockReturnValue({ code: 1, stdout: "", stderr: "boom" });
    await expect(codex.install!()).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });
});
