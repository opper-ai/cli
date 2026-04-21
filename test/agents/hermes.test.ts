import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const whichMock = vi.fn();
const runMock = vi.fn();

vi.mock("../../src/util/which.js", () => ({ which: whichMock }));
vi.mock("../../src/util/run.js", () => ({ run: runMock }));

const { hermes } = await import("../../src/agents/hermes.js");

describe("hermes adapter — detect", () => {
  it("returns installed=false when `which hermes` returns null", async () => {
    whichMock.mockResolvedValue(null);
    const result = await hermes.detect();
    expect(result.installed).toBe(false);
    expect(result.version).toBeUndefined();
  });

  it("returns installed=true with version when hermes is on PATH", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/hermes");
    runMock.mockReturnValue({
      code: 0,
      stdout: "hermes 1.2.3\n",
      stderr: "",
    });
    const result = await hermes.detect();
    expect(result.installed).toBe(true);
    expect(result.version).toBe("1.2.3");
    expect(result.configPath).toMatch(/\.hermes\/config\.yaml$/);
  });

  it("returns installed=true with undefined version when --version fails", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/hermes");
    runMock.mockReturnValue({ code: 1, stdout: "", stderr: "boom" });
    const result = await hermes.detect();
    expect(result.installed).toBe(true);
    expect(result.version).toBeUndefined();
  });
});

describe("hermes adapter — metadata", () => {
  it("has the expected name, displayName, binary, docsUrl", () => {
    expect(hermes.name).toBe("hermes");
    expect(hermes.displayName).toBe("Hermes Agent");
    expect(hermes.binary).toBe("hermes");
    expect(hermes.docsUrl).toBe("https://hermes-agent.nousresearch.com/docs/");
  });
});

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("hermes adapter — snapshot/restore", () => {
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
  });
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevOpperHome === undefined) delete process.env.OPPER_HOME;
    else process.env.OPPER_HOME = prevOpperHome;
  });

  it("snapshotConfig copies the hermes config into backups", async () => {
    const live = join(sandbox, ".hermes", "config.yaml");
    writeFileSync(live, "model:\n  provider: openrouter\n", "utf8");
    const handle = await hermes.snapshotConfig();
    expect(handle.agent).toBe("hermes");
    expect(existsSync(handle.backupPath)).toBe(true);
    expect(readFileSync(handle.backupPath, "utf8")).toContain("openrouter");
  });

  it("snapshotConfig throws AGENT_CONFIG_CONFLICT when no hermes config exists", async () => {
    await expect(hermes.snapshotConfig()).rejects.toMatchObject({
      code: "AGENT_CONFIG_CONFLICT",
    });
  });

  it("restoreConfig copies the backup back over the live file", async () => {
    const live = join(sandbox, ".hermes", "config.yaml");
    writeFileSync(live, "original\n", "utf8");
    const handle = await hermes.snapshotConfig();
    writeFileSync(live, "mutated\n", "utf8");
    await hermes.restoreConfig(handle);
    expect(readFileSync(live, "utf8")).toBe("original\n");
  });
});

describe("hermes adapter — writeOpperConfig", () => {
  let sandbox: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "opper-hermes-write-"));
    prevHome = process.env.HOME;
    process.env.HOME = sandbox;
    mkdirSync(join(sandbox, ".hermes"), { recursive: true });
  });
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });

  it("rewrites the model: block and preserves other sections", async () => {
    const live = join(sandbox, ".hermes", "config.yaml");
    writeFileSync(
      live,
      [
        "model:",
        "  provider: openrouter",
        "  model: openai/gpt-4o",
        "tools:",
        "  enabled: [search, shell]",
        "gateway:",
        "  telegram: true",
      ].join("\n") + "\n",
      "utf8",
    );

    await hermes.writeOpperConfig({
      baseUrl: "https://api.opper.ai/v3/openai",
      apiKey: "op_live_test",
      model: "anthropic/claude-opus-4.7",
      compatShape: "openai",
    });

    const { parse } = await import("yaml");
    const parsed = parse(readFileSync(live, "utf8")) as {
      model: Record<string, unknown>;
      tools: Record<string, unknown>;
      gateway: Record<string, unknown>;
    };
    expect(parsed.model).toEqual({
      provider: "openai",
      model: "anthropic/claude-opus-4.7",
      base_url: "https://api.opper.ai/v3/openai",
      api_key: "op_live_test",
    });
    expect(parsed.tools).toEqual({ enabled: ["search", "shell"] });
    expect(parsed.gateway).toEqual({ telegram: true });
  });

  it("creates the model block if missing", async () => {
    const live = join(sandbox, ".hermes", "config.yaml");
    writeFileSync(live, "tools:\n  enabled: []\n", "utf8");
    await hermes.writeOpperConfig({
      baseUrl: "https://api.opper.ai/v3/openai",
      apiKey: "op_live_x",
      model: "anthropic/claude-opus-4.7",
      compatShape: "openai",
    });
    const { parse } = await import("yaml");
    const parsed = parse(readFileSync(live, "utf8")) as {
      model?: { provider?: string };
    };
    expect(parsed.model?.provider).toBe("openai");
  });

  it("writes atomically via a temp file + rename", async () => {
    const live = join(sandbox, ".hermes", "config.yaml");
    writeFileSync(live, "model: {}\n", "utf8");
    await hermes.writeOpperConfig({
      baseUrl: "https://api.opper.ai/v3/openai",
      apiKey: "k",
      model: "m",
      compatShape: "openai",
    });
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(join(sandbox, ".hermes"));
    expect(files.filter((f) => f.includes(".tmp."))).toHaveLength(0);
  });
});

describe("hermes adapter — spawn", () => {
  it("runs the hermes binary with inherited stdio and returns the exit code", async () => {
    runMock.mockClear();
    runMock.mockReturnValue({ code: 0, stdout: "", stderr: "" });
    const code = await hermes.spawn(["--foo", "bar"]);
    expect(code).toBe(0);
    expect(runMock).toHaveBeenCalledWith(
      "hermes",
      ["--foo", "bar"],
      { inherit: true },
    );
  });

  it("propagates non-zero exit codes", async () => {
    runMock.mockClear();
    runMock.mockReturnValue({ code: 2, stdout: "", stderr: "" });
    const code = await hermes.spawn([]);
    expect(code).toBe(2);
  });
});
