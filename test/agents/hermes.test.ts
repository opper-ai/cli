import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const whichMock = vi.fn();
const runMock = vi.fn();

vi.mock("../../src/util/which.js", () => ({ which: whichMock }));
vi.mock("../../src/util/run.js", () => ({ run: runMock }));

const { hermes } = await import("../../src/agents/hermes.js");

const ROUTING = {
  baseUrl: "https://api.opper.ai/v3/compat",
  apiKey: "op_live_test",
  model: "claude-opus-4-7",
  compatShape: "openai" as const,
};

describe("hermes adapter — metadata", () => {
  it("has the expected name, displayName, docsUrl, spawn", () => {
    expect(hermes.name).toBe("hermes");
    expect(hermes.displayName).toBe("Hermes Agent");
    expect(hermes.docsUrl).toBe("https://hermes-agent.nousresearch.com/docs/");
    expect(typeof hermes.spawn).toBe("function");
    expect(typeof hermes.install).toBe("function");
  });
});

describe("hermes adapter — detect", () => {
  it("returns installed=false when `which hermes` returns null", async () => {
    whichMock.mockResolvedValue(null);
    expect((await hermes.detect()).installed).toBe(false);
  });

  it("returns installed=true with semver and the real ~/.hermes config path", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/hermes");
    runMock.mockReturnValue({ code: 0, stdout: "hermes 1.2.3\n", stderr: "" });
    const result = await hermes.detect();
    expect(result.installed).toBe(true);
    expect(result.version).toBe("1.2.3");
    // The user's real home, not an isolated dir.
    expect(result.configPath).toMatch(/\.hermes\/config\.yaml$/);
    expect(result.configPath).not.toMatch(/hermes-home/);
  });
});

describe("hermes adapter — install", () => {
  it("throws OpperError(AGENT_NOT_FOUND) when the installer exits non-zero", async () => {
    runMock.mockClear();
    runMock.mockReturnValue({ code: 1, stdout: "", stderr: "boom" });
    await expect(hermes.install!()).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  it("resolves when the installer exits 0", async () => {
    runMock.mockClear();
    runMock.mockReturnValue({ code: 0, stdout: "", stderr: "" });
    await expect(hermes.install!()).resolves.toBeUndefined();
  });
});

describe("hermes adapter — spawn (real ~/.hermes, transient)", () => {
  let sandbox: string;
  let prevHome: string | undefined;
  let prevOpperHome: string | undefined;

  function configPath(): string {
    return join(sandbox, ".hermes", "config.yaml");
  }
  function pluginDir(): string {
    return join(sandbox, ".hermes", "plugins", "model-providers", "opper");
  }

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "opper-hermes-"));
    prevHome = process.env.HOME;
    prevOpperHome = process.env.OPPER_HOME;
    process.env.HOME = sandbox;
    process.env.OPPER_HOME = join(sandbox, ".opper"); // sandbox the backups dir
    runMock.mockReset();
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevOpperHome === undefined) delete process.env.OPPER_HOME;
    else process.env.OPPER_HOME = prevOpperHome;
  });

  it("writes the opper model + provider AND ships the plugin into ~/.hermes mid-launch", async () => {
    let mid: { cfg: Record<string, unknown>; pluginSrc: string } | undefined;
    runMock.mockImplementation(() => {
      mid = {
        cfg: parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>,
        pluginSrc: readFileSync(join(pluginDir(), "__init__.py"), "utf8"),
      };
      return { code: 0, stdout: "", stderr: "" };
    });

    const SESSION_URL = "https://api.opper.ai/v3/session/sess_test";
    const code = await hermes.spawn!([], { ...ROUTING, baseUrl: SESSION_URL });
    expect(code).toBe(0);

    const model = mid?.cfg.model as Record<string, unknown>;
    expect(model).toEqual({ provider: "opper", base_url: SESSION_URL, default: "claude-opus-4-7" });
    expect(model).not.toHaveProperty("api_key"); // key goes via env, not disk
    const providers = mid?.cfg.providers as {
      opper?: { base_url?: string; key_env?: string; models?: Record<string, unknown> };
    };
    expect(providers.opper?.base_url).toBe(SESSION_URL);
    expect(providers.opper?.key_env).toBe("OPPER_API_KEY");
    expect(Object.keys(providers.opper?.models ?? {})).toContain("claude-opus-4-7");
    expect(mid?.pluginSrc).toContain("X-Opper-Trace-Id");
  });

  it("passes the real HERMES_HOME and OPPER_API_KEY through the env", async () => {
    runMock.mockReturnValue({ code: 0, stdout: "", stderr: "" });
    await hermes.spawn!([], ROUTING);
    const [, , runOpts] = runMock.mock.calls[0]!;
    const env = (runOpts as { env: Record<string, string> }).env;
    expect(env.HERMES_HOME).toBe(join(sandbox, ".hermes"));
    expect(env.OPPER_API_KEY).toBe("op_live_test");
  });

  it("leaves nothing behind when there was no prior config (one-off launch)", async () => {
    runMock.mockReturnValue({ code: 0, stdout: "", stderr: "" });
    expect(existsSync(configPath())).toBe(false);
    await hermes.spawn!([], ROUTING);
    expect(existsSync(configPath())).toBe(false);
    expect(existsSync(pluginDir())).toBe(false);
  });

  it("restores the user's pre-existing config.yaml and plugin exactly", async () => {
    mkdirSync(join(sandbox, ".hermes"), { recursive: true });
    const userConfig =
      ["model:", "  provider: anthropic", "  default: claude", "toolsets:", "  - web"].join("\n") + "\n";
    writeFileSync(configPath(), userConfig, "utf8");
    mkdirSync(pluginDir(), { recursive: true });
    writeFileSync(join(pluginDir(), "__init__.py"), "# user's own\n", "utf8");

    runMock.mockReturnValue({ code: 0, stdout: "", stderr: "" });
    await hermes.spawn!([], ROUTING);

    // Whole-file restore: the user's config + their plugin file come back verbatim.
    expect(readFileSync(configPath(), "utf8")).toBe(userConfig);
    expect(readFileSync(join(pluginDir(), "__init__.py"), "utf8")).toBe("# user's own\n");
  });

  it("propagates non-zero exit codes from run()", async () => {
    runMock.mockReturnValue({ code: 2, stdout: "", stderr: "" });
    expect(await hermes.spawn!([], ROUTING)).toBe(2);
  });

  it("restores config even when run() throws", async () => {
    mkdirSync(join(sandbox, ".hermes"), { recursive: true });
    const userConfig = "model:\n  provider: anthropic\n";
    writeFileSync(configPath(), userConfig, "utf8");
    runMock.mockImplementation(() => {
      throw new Error("spawn blew up");
    });
    await expect(hermes.spawn!([], ROUTING)).rejects.toThrow("spawn blew up");
    expect(readFileSync(configPath(), "utf8")).toBe(userConfig);
  });
});

describe("hermes adapter — isConfigured / configure / unconfigure", () => {
  let sandbox: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "opper-hermes-"));
    prevHome = process.env.HOME;
    process.env.HOME = sandbox;
    runMock.mockReset();
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });

  it("isConfigured collapses to installed", async () => {
    whichMock.mockResolvedValue(null);
    expect(await hermes.isConfigured()).toBe(false);
    whichMock.mockResolvedValue("/usr/local/bin/hermes");
    runMock.mockReturnValue({ code: 0, stdout: "hermes 1.0.0\n", stderr: "" });
    expect(await hermes.isConfigured()).toBe(true);
  });

  it("configure throws when hermes is not installed", async () => {
    whichMock.mockResolvedValue(null);
    await expect(hermes.configure({})).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  it("unconfigure removes a leftover opper plugin dir", async () => {
    const dir = join(sandbox, ".hermes", "plugins", "model-providers", "opper");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "__init__.py"), "x\n", "utf8");
    await hermes.unconfigure();
    expect(existsSync(dir)).toBe(false);
  });
});
