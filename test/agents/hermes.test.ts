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
import { parse } from "yaml";

const whichMock = vi.fn();
const runMock = vi.fn();

vi.mock("../../src/util/which.js", () => ({ which: whichMock }));
vi.mock("../../src/util/run.js", () => ({ run: runMock }));

const { hermes } = await import("../../src/agents/hermes.js");

const ROUTING = {
  baseUrl: "https://api.opper.ai/v3/openai",
  apiKey: "op_live_test",
  model: "anthropic/claude-opus-4.7",
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
    const result = await hermes.detect();
    expect(result.installed).toBe(false);
    expect(result.version).toBeUndefined();
  });

  it("returns installed=true with semver when --version succeeds", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/hermes");
    runMock.mockReturnValue({ code: 0, stdout: "hermes 1.2.3\n", stderr: "" });
    const result = await hermes.detect();
    expect(result.installed).toBe(true);
    expect(result.version).toBe("1.2.3");
    expect(result.configPath).toMatch(/\.hermes\/config\.yaml$/);
  });

  it("returns installed=true with no version when --version output has no semver token", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/hermes");
    runMock.mockReturnValue({
      code: 0,
      stdout: "hermes vupdate available — run `hermes update`\n",
      stderr: "",
    });
    const result = await hermes.detect();
    expect(result.installed).toBe(true);
    expect(result.version).toBeUndefined();
  });

  it("returns installed=true with undefined version when --version fails", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/hermes");
    runMock.mockReturnValue({ code: 1, stdout: "", stderr: "boom" });
    const result = await hermes.detect();
    expect(result.installed).toBe(true);
    expect(result.version).toBeUndefined();
  });
});

describe("hermes adapter — install", () => {
  it("throws OpperError(AGENT_NOT_FOUND) when the installer exits non-zero", async () => {
    runMock.mockClear();
    runMock.mockReturnValue({ code: 1, stdout: "", stderr: "boom" });
    await expect(hermes.install!()).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  });

  it("resolves when the installer exits 0", async () => {
    runMock.mockClear();
    runMock.mockReturnValue({ code: 0, stdout: "", stderr: "" });
    await expect(hermes.install!()).resolves.toBeUndefined();
  });
});

describe("hermes adapter — spawn (snapshot/write/run/restore)", () => {
  let sandbox: string;
  let prevHome: string | undefined;
  let prevOpperHome: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "opper-hermes-"));
    prevHome = process.env.HOME;
    prevOpperHome = process.env.OPPER_HOME;
    process.env.HOME = sandbox;
    process.env.OPPER_HOME = join(sandbox, ".opper");
    mkdirSync(join(sandbox, ".hermes"), { recursive: true });
    runMock.mockReset();
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevOpperHome === undefined) delete process.env.OPPER_HOME;
    else process.env.OPPER_HOME = prevOpperHome;
  });

  it("throws AGENT_CONFIG_CONFLICT when the hermes config does not exist", async () => {
    await expect(hermes.spawn!([], ROUTING)).rejects.toMatchObject({
      code: "AGENT_CONFIG_CONFLICT",
    });
  });

  it("rewrites the model: block during run, then restores the original on exit", async () => {
    const live = join(sandbox, ".hermes", "config.yaml");
    writeFileSync(
      live,
      [
        "model:",
        "  provider: openrouter",
        "  model: openai/gpt-4o",
        "tools:",
        "  enabled: [search, shell]",
      ].join("\n") + "\n",
      "utf8",
    );

    // Capture what hermes saw at run time by reading the live config inside
    // the run() mock — that's the moment the file is in its routed state.
    let observed: { model?: Record<string, unknown>; tools?: unknown } | null = null;
    runMock.mockImplementation(() => {
      observed = parse(readFileSync(live, "utf8")) as typeof observed;
      return { code: 0, stdout: "", stderr: "" };
    });

    const code = await hermes.spawn!(["chat"], ROUTING);
    expect(code).toBe(0);

    // During the run, hermes saw the rewritten model block plus the
    // untouched tools block.
    expect(observed!.model).toEqual({
      provider: "openai",
      model: "anthropic/claude-opus-4.7",
      base_url: "https://api.opper.ai/v3/openai",
      api_key: "op_live_test",
    });
    expect(observed!.tools).toEqual({ enabled: ["search", "shell"] });

    // After spawn returns, the live config is back to the original.
    const after = parse(readFileSync(live, "utf8")) as { model?: Record<string, unknown> };
    expect(after.model).toEqual({
      provider: "openrouter",
      model: "openai/gpt-4o",
    });
  });

  it("propagates non-zero exit codes from run()", async () => {
    const live = join(sandbox, ".hermes", "config.yaml");
    writeFileSync(live, "model: {}\n", "utf8");
    runMock.mockReturnValue({ code: 2, stdout: "", stderr: "" });
    const code = await hermes.spawn!([], ROUTING);
    expect(code).toBe(2);
  });

  it("restores the config even if run() throws", async () => {
    const live = join(sandbox, ".hermes", "config.yaml");
    writeFileSync(live, "model:\n  provider: openrouter\n", "utf8");
    runMock.mockImplementation(() => {
      throw new Error("spawn died");
    });
    await expect(hermes.spawn!([], ROUTING)).rejects.toThrow("spawn died");
    expect(readFileSync(live, "utf8")).toContain("openrouter");
  });

  it("leaves no .tmp.* files behind after a successful run", async () => {
    const live = join(sandbox, ".hermes", "config.yaml");
    writeFileSync(live, "model: {}\n", "utf8");
    runMock.mockReturnValue({ code: 0, stdout: "", stderr: "" });
    await hermes.spawn!([], ROUTING);
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(join(sandbox, ".hermes"));
    expect(files.filter((f) => f.includes(".tmp."))).toHaveLength(0);
  });
});

describe("hermes adapter — isConfigured / configure / unconfigure", () => {
  beforeEach(() => {
    runMock.mockReset();
  });

  it("isConfigured collapses to installed", async () => {
    whichMock.mockResolvedValue(null);
    expect(await hermes.isConfigured()).toBe(false);
    whichMock.mockResolvedValue("/usr/local/bin/hermes");
    runMock.mockReturnValue({ code: 0, stdout: "hermes 1.0.0\n", stderr: "" });
    expect(await hermes.isConfigured()).toBe(true);
  });

  it("configure throws AGENT_NOT_FOUND when not installed", async () => {
    whichMock.mockResolvedValue(null);
    await expect(hermes.configure({})).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  });

  it("unconfigure is a no-op", async () => {
    await expect(hermes.unconfigure()).resolves.toBeUndefined();
  });
});
