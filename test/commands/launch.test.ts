import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const adapter = {
  name: "hermes",
  displayName: "Hermes Agent",
  binary: "hermes",
  docsUrl: "https://example",
  detect: vi.fn(),
  install: vi.fn(),
  snapshotConfig: vi.fn(),
  writeOpperConfig: vi.fn(),
  restoreConfig: vi.fn(),
  spawn: vi.fn(),
};

vi.mock("../../src/agents/registry.js", () => ({
  getAdapter: (name: string) => (name === "hermes" ? adapter : null),
  listAdapters: () => [adapter],
}));

const loginMock = vi.fn();
vi.mock("../../src/commands/login.js", () => ({ loginCommand: loginMock }));

const { launchCommand } = await import("../../src/commands/launch.js");

useTempOpperHome();

describe("launchCommand", () => {
  beforeEach(() => {
    adapter.detect.mockReset();
    adapter.install.mockReset();
    adapter.snapshotConfig.mockReset();
    adapter.writeOpperConfig.mockReset();
    adapter.restoreConfig.mockReset();
    adapter.spawn.mockReset();
    loginMock.mockReset();
  });

  it("throws AGENT_NOT_FOUND when the adapter name is unknown", async () => {
    await expect(
      launchCommand({ agent: "nonexistent", key: "default" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  it("throws AUTH_REQUIRED when no slot is stored", async () => {
    adapter.detect.mockResolvedValue({ installed: true });
    await expect(
      launchCommand({ agent: "hermes", key: "default" }),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("throws AGENT_NOT_FOUND when the agent isn't installed and --install wasn't passed", async () => {
    await setSlot("default", { apiKey: "op_live_x" });
    adapter.detect.mockResolvedValue({ installed: false });
    await expect(
      launchCommand({ agent: "hermes", key: "default" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  it("installs, snapshots, writes config, spawns, and restores on a happy path", async () => {
    await setSlot("default", { apiKey: "op_live_happy" });
    adapter.detect.mockResolvedValue({ installed: true });
    adapter.snapshotConfig.mockResolvedValue({
      agent: "hermes",
      backupPath: "/tmp/hermes-X.yaml",
      timestamp: "2026-04-21T00:00:00Z",
    });
    adapter.writeOpperConfig.mockResolvedValue(undefined);
    adapter.spawn.mockResolvedValue(0);
    adapter.restoreConfig.mockResolvedValue(undefined);

    const code = await launchCommand({
      agent: "hermes",
      key: "default",
      model: "anthropic/claude-opus-4.7",
      passthrough: ["chat", "hi"],
    });

    expect(code).toBe(0);
    expect(adapter.snapshotConfig).toHaveBeenCalled();
    expect(adapter.writeOpperConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "op_live_happy",
        model: "anthropic/claude-opus-4.7",
        compatShape: "openai",
      }),
    );
    expect(adapter.spawn).toHaveBeenCalledWith(["chat", "hi"]);
    expect(adapter.restoreConfig).toHaveBeenCalled();
  });

  it("restores the config even if spawn throws", async () => {
    await setSlot("default", { apiKey: "op_live_x" });
    adapter.detect.mockResolvedValue({ installed: true });
    adapter.snapshotConfig.mockResolvedValue({
      agent: "hermes",
      backupPath: "/tmp/x.yaml",
      timestamp: "t",
    });
    adapter.writeOpperConfig.mockResolvedValue(undefined);
    adapter.spawn.mockRejectedValue(new Error("spawn died"));

    await expect(
      launchCommand({ agent: "hermes", key: "default" }),
    ).rejects.toThrow("spawn died");
    expect(adapter.restoreConfig).toHaveBeenCalled();
  });

  it("restores config when spawn returns a non-zero exit code (e.g. after Ctrl-C)", async () => {
    await setSlot("default", { apiKey: "op_live_x" });
    adapter.detect.mockResolvedValue({ installed: true });
    adapter.snapshotConfig.mockResolvedValue({
      agent: "hermes",
      backupPath: "/tmp/x.yaml",
      timestamp: "t",
    });
    adapter.writeOpperConfig.mockResolvedValue(undefined);
    adapter.spawn.mockResolvedValue(-1); // simulates signalled exit
    adapter.restoreConfig.mockResolvedValue(undefined);

    const code = await launchCommand({ agent: "hermes", key: "default" });
    expect(code).toBe(-1);
    expect(adapter.restoreConfig).toHaveBeenCalled();
  });
});
