import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
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
    // configPath now points at the Opper-managed HERMES_HOME, not ~/.hermes.
    expect(result.configPath).toMatch(/hermes-home\/config\.yaml$/);
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

describe("hermes adapter — spawn (isolated HERMES_HOME)", () => {
  let sandbox: string;
  let prevOpperHome: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "opper-hermes-"));
    prevOpperHome = process.env.OPPER_HOME;
    process.env.OPPER_HOME = join(sandbox, ".opper");
    runMock.mockReset();
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    if (prevOpperHome === undefined) delete process.env.OPPER_HOME;
    else process.env.OPPER_HOME = prevOpperHome;
  });

  it("creates the Opper-managed hermes-home and writes a custom-provider config.yaml", async () => {
    runMock.mockReturnValue({ code: 0, stdout: "", stderr: "" });

    const code = await hermes.spawn!(["chat"], ROUTING);
    expect(code).toBe(0);

    const configPath = join(sandbox, ".opper", "hermes-home", "config.yaml");
    expect(existsSync(configPath)).toBe(true);
    const written = parse(readFileSync(configPath, "utf8")) as {
      model?: Record<string, unknown>;
    };
    expect(written.model).toEqual({
      provider: "custom",
      base_url: "https://api.opper.ai/v3/openai",
      default: "anthropic/claude-opus-4.7",
    });
    // api_key intentionally NOT written to disk — it goes via env.
    expect(written.model).not.toHaveProperty("api_key");
  });

  it("passes HERMES_HOME and OPENAI_API_KEY through to the hermes process env", async () => {
    runMock.mockReturnValue({ code: 0, stdout: "", stderr: "" });

    await hermes.spawn!([], ROUTING);

    expect(runMock).toHaveBeenCalledTimes(1);
    const [, , runOpts] = runMock.mock.calls[0]!;
    const env = (runOpts as { env: Record<string, string> }).env;
    expect(env.HERMES_HOME).toBe(join(sandbox, ".opper", "hermes-home"));
    expect(env.OPENAI_API_KEY).toBe("op_live_test");
  });

  it("preserves non-model settings already present in the Opper-managed config.yaml", async () => {
    // First launch creates the dir + writes model:
    runMock.mockReturnValue({ code: 0, stdout: "", stderr: "" });
    await hermes.spawn!([], ROUTING);

    // User (or a previous Hermes run) added a `toolsets:` block to that file.
    const configPath = join(sandbox, ".opper", "hermes-home", "config.yaml");
    writeFileSync(
      configPath,
      [
        "model:",
        "  provider: custom",
        "  base_url: https://stale.example",
        "  default: stale-model",
        "toolsets:",
        "  - hermes-cli",
        "  - web",
      ].join("\n") + "\n",
      "utf8",
    );

    // Second launch must rewrite model: but leave toolsets: alone.
    await hermes.spawn!([], ROUTING);
    const after = parse(readFileSync(configPath, "utf8")) as {
      model?: Record<string, unknown>;
      toolsets?: unknown;
    };
    expect(after.model).toEqual({
      provider: "custom",
      base_url: "https://api.opper.ai/v3/openai",
      default: "anthropic/claude-opus-4.7",
    });
    expect(after.toolsets).toEqual(["hermes-cli", "web"]);
  });

  it("propagates non-zero exit codes from run()", async () => {
    runMock.mockReturnValue({ code: 2, stdout: "", stderr: "" });
    const code = await hermes.spawn!([], ROUTING);
    expect(code).toBe(2);
  });

  it("does not touch the user's real ~/.hermes/ directory", async () => {
    runMock.mockReturnValue({ code: 0, stdout: "", stderr: "" });
    await hermes.spawn!([], ROUTING);
    // Nothing under sandbox/.hermes should exist — we only write under .opper.
    expect(existsSync(join(sandbox, ".hermes"))).toBe(false);
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
