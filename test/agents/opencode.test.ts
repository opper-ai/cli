import { describe, it, expect, vi, beforeEach } from "vitest";

const whichMock = vi.fn();
vi.mock("../../src/util/which.js", () => ({ which: whichMock }));

const configureOpenCodeMock = vi.fn();
vi.mock("../../src/setup/opencode.js", () => ({
  configureOpenCode: configureOpenCodeMock,
}));

const spawnSyncMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return { ...actual, spawnSync: spawnSyncMock };
});

const { opencode } = await import("../../src/agents/opencode.js");

describe("opencode adapter", () => {
  beforeEach(() => {
    whichMock.mockReset();
    configureOpenCodeMock.mockReset();
    spawnSyncMock.mockReset();
  });

  it("detect returns installed=false when opencode not on PATH", async () => {
    whichMock.mockResolvedValue(null);
    const result = await opencode.detect();
    expect(result.installed).toBe(false);
  });

  it("detect returns installed=true when binary found", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/opencode");
    const result = await opencode.detect();
    expect(result.installed).toBe(true);
  });

  it("install throws AGENT_NOT_FOUND with a hint pointing at opencode.ai", async () => {
    await expect(opencode.install()).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  });

  it("writeOpperConfig calls configureOpenCode and stashes the routing for spawn", async () => {
    configureOpenCodeMock.mockResolvedValue({
      path: "/tmp/opencode.json",
      wrote: true,
    });
    await opencode.writeOpperConfig({
      baseUrl: "https://api.opper.ai/v3/openai",
      apiKey: "op_live_run",
      model: "anthropic/claude-opus-4.7",
      compatShape: "openai",
    });
    expect(configureOpenCodeMock).toHaveBeenCalledWith({ location: "global" });

    spawnSyncMock.mockReturnValue({ status: 0 });
    const code = await opencode.spawn(["chat"]);
    expect(code).toBe(0);
    const call = spawnSyncMock.mock.calls[0]!;
    expect(call[0]).toBe("opencode");
    expect(call[1]).toEqual(["chat"]);
    const init = call[2] as { env: NodeJS.ProcessEnv };
    expect(init.env.OPPER_API_KEY).toBe("op_live_run");
  });

  it("spawn propagates non-zero exit codes", async () => {
    spawnSyncMock.mockReturnValue({ status: 2 });
    const code = await opencode.spawn([]);
    expect(code).toBe(2);
  });

  it("metadata is correct", () => {
    expect(opencode.name).toBe("opencode");
    expect(opencode.displayName).toBe("OpenCode");
    expect(opencode.binary).toBe("opencode");
    expect(opencode.docsUrl).toMatch(/^https:\/\//);
  });
});
