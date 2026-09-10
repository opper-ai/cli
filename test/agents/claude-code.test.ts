import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const whichMock = vi.fn();
vi.mock("../../src/util/which.js", () => ({ which: whichMock }));

const runMock = vi.fn();
vi.mock("../../src/util/run.js", () => ({ run: runMock }));

const spawnSyncMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return { ...actual, spawnSync: spawnSyncMock };
});

const { claudeCode } = await import("../../src/agents/claude-code.js");

const ROUTING = {
  baseUrl: "https://api.opper.ai/v3/session/sess_aa11bb22-cccc-4ddd-8eee-ffff00001111/customer:acme",
  apiKey: "op_live_run",
  model: "claude-sonnet-4-6",
  compatShape: "openai" as const,
};

describe("claude-code adapter", () => {
  beforeEach(() => {
    whichMock.mockReset();
    runMock.mockReset();
    spawnSyncMock.mockReset();
    vi.stubEnv("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", undefined);
    vi.stubEnv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("metadata is correct", () => {
    expect(claudeCode.name).toBe("claude");
    expect(claudeCode.displayName).toBe("Claude Code");
    expect(typeof claudeCode.spawn).toBe("function");
    expect(claudeCode.docsUrl).toMatch(/^https:\/\//);
  });

  it("detect returns installed=false when claude not on PATH", async () => {
    whichMock.mockResolvedValue(null);
    const result = await claudeCode.detect();
    expect(result.installed).toBe(false);
  });

  it("detect returns installed=true when binary found", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/claude");
    const result = await claudeCode.detect();
    expect(result.installed).toBe(true);
  });

  it("isConfigured collapses to installed", async () => {
    whichMock.mockResolvedValue(null);
    expect(await claudeCode.isConfigured()).toBe(false);
    whichMock.mockResolvedValue("/usr/local/bin/claude");
    expect(await claudeCode.isConfigured()).toBe(true);
  });

  it("configure throws AGENT_NOT_FOUND when claude isn't installed", async () => {
    whichMock.mockResolvedValue(null);
    await expect(claudeCode.configure({})).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  });

  it("install runs `npm i -g @anthropic-ai/claude-code` and resolves on exit 0", async () => {
    whichMock.mockResolvedValue("/usr/bin/npm");
    runMock.mockReturnValue({ code: 0, stdout: "", stderr: "" });
    await expect(claudeCode.install!()).resolves.toBeUndefined();
    const [cmd, args, options] = runMock.mock.calls[0]!;
    expect(cmd).toMatch(/^npm(\.cmd)?$/);
    expect(args).toEqual(["install", "-g", "@anthropic-ai/claude-code"]);
    expect(options).toMatchObject({ inherit: true });
  });

  it("install throws AGENT_NOT_FOUND when npm exits non-zero", async () => {
    whichMock.mockResolvedValue("/usr/bin/npm");
    runMock.mockReturnValue({ code: 1, stdout: "", stderr: "boom" });
    await expect(claudeCode.install!()).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  });

  it("spawn injects ANTHROPIC_* env vars from the routing", async () => {
    spawnSyncMock.mockReturnValue({ status: 0 });
    const code = await claudeCode.spawn!(["chat"], ROUTING);
    expect(code).toBe(0);

    const call = spawnSyncMock.mock.calls[0]!;
    expect(call[0]).toBe("claude");
    expect(call[1]).toEqual(["chat"]);
    const init = call[2] as { env: NodeJS.ProcessEnv };
    expect(init.env.ANTHROPIC_BASE_URL).toBe(
      "https://api.opper.ai/v3/session/sess_aa11bb22-cccc-4ddd-8eee-ffff00001111/customer:acme",
    );
    expect(init.env.ANTHROPIC_AUTH_TOKEN).toBe("op_live_run");
    expect(init.env.ANTHROPIC_MODEL).toBe("claude-sonnet-4-6");
    // Stops Claude Code from pinging api.anthropic.com directly when
    // routing is supposed to be Opper-only.
    expect(init.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    // Gateway discovery is opt-in, and remains enabled while nonessential
    // traffic is disabled on supported Claude Code versions.
    expect(init.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
    expect(process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBeUndefined();
    expect(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();
    // The picker discovers models from the session gateway without replacing
    // Claude Code's family defaults.
    expect(init.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(init.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(init.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
  });

  it("enables discovery only for the Opper child when the parent disables it", async () => {
    vi.stubEnv("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "0");
    vi.stubEnv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "0");
    spawnSyncMock.mockReturnValue({ status: 0 });

    await claudeCode.spawn!([], ROUTING);

    const init = spawnSyncMock.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(init.env).not.toBe(process.env);
    expect(init.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("1");
    expect(init.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe("0");
    expect(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("0");
  });

  it("spawn propagates non-zero exit codes", async () => {
    spawnSyncMock.mockReturnValue({ status: 2 });
    const code = await claudeCode.spawn!([], ROUTING);
    expect(code).toBe(2);
  });
});
