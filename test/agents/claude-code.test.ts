import { describe, it, expect, vi, beforeEach } from "vitest";

const whichMock = vi.fn();
vi.mock("../../src/util/which.js", () => ({ which: whichMock }));

const spawnSyncMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return { ...actual, spawnSync: spawnSyncMock };
});

const { claudeCode } = await import("../../src/agents/claude-code.js");

const ROUTING = {
  baseUrl: "ignored-by-this-adapter",
  apiKey: "op_live_run",
  model: "claude-sonnet-4-6",
  compatShape: "openai" as const,
};

describe("claude-code adapter", () => {
  beforeEach(() => {
    whichMock.mockReset();
    spawnSyncMock.mockReset();
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

  it("install throws with the install hint", async () => {
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
    expect(init.env.ANTHROPIC_BASE_URL).toBe("https://api.opper.ai/v3/compat");
    expect(init.env.ANTHROPIC_AUTH_TOKEN).toBe("op_live_run");
    expect(init.env.ANTHROPIC_MODEL).toBe("claude-sonnet-4-6");
    // Stops Claude Code from pinging api.anthropic.com directly when
    // routing is supposed to be Opper-only.
    expect(init.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    // The /model picker now pulls entries from /v3/compat/v1/models — we
    // should NOT be setting the legacy tier-override env vars.
    expect(init.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(init.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(init.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
  });

  it("spawn propagates non-zero exit codes", async () => {
    spawnSyncMock.mockReturnValue({ status: 2 });
    const code = await claudeCode.spawn!([], ROUTING);
    expect(code).toBe(2);
  });
});
