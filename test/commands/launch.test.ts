import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const adapter = {
  name: "hermes",
  displayName: "Hermes Agent",
  docsUrl: "https://example",
  detect: vi.fn(),
  isConfigured: vi.fn(),
  configure: vi.fn(),
  unconfigure: vi.fn(),
  install: vi.fn(),
  spawn: vi.fn(),
};

const getAdapterMock = vi.fn((name: string) =>
  name === "hermes" ? adapter : null,
);
vi.mock("../../src/agents/registry.js", () => ({
  getAdapter: getAdapterMock,
  listAdapters: () => [adapter],
}));

const loginMock = vi.fn();
vi.mock("../../src/commands/login.js", () => ({ loginCommand: loginMock }));

const { launchCommand } = await import("../../src/commands/launch.js");

useTempOpperHome();

describe("launchCommand", () => {
  beforeEach(() => {
    adapter.detect.mockReset();
    adapter.isConfigured.mockReset();
    adapter.configure.mockReset();
    adapter.unconfigure.mockReset();
    adapter.install.mockReset();
    adapter.spawn.mockReset();
    loginMock.mockReset();
  });

  it("throws AGENT_NOT_FOUND when the adapter name is unknown", async () => {
    await expect(
      launchCommand({ agent: "nonexistent", key: "default" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  it("calls loginCommand when no slot is stored, then continues with the new slot", async () => {
    adapter.detect.mockResolvedValue({ installed: true });
    adapter.spawn.mockResolvedValue(0);
    loginMock.mockImplementation(async () => {
      await setSlot("default", { apiKey: "op_live_fresh" });
    });

    const code = await launchCommand({ agent: "hermes", key: "default" });
    expect(loginMock).toHaveBeenCalledWith({ key: "default" });
    expect(code).toBe(0);
    expect(adapter.spawn).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ apiKey: "op_live_fresh" }),
    );
  });

  it("still throws AUTH_REQUIRED if login completes without storing a slot", async () => {
    loginMock.mockResolvedValue(undefined);
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

  it("calls adapter.spawn with the routing on a happy path", async () => {
    await setSlot("default", { apiKey: "op_live_happy" });
    adapter.detect.mockResolvedValue({ installed: true });
    adapter.spawn.mockResolvedValue(0);

    const code = await launchCommand({
      agent: "hermes",
      key: "default",
      model: "anthropic/claude-opus-4.7",
      passthrough: ["chat", "hi"],
    });

    expect(code).toBe(0);
    expect(adapter.spawn).toHaveBeenCalledWith(
      ["chat", "hi"],
      expect.objectContaining({
        apiKey: "op_live_happy",
        model: "anthropic/claude-opus-4.7",
        compatShape: "openai",
      }),
    );
  });

  it("propagates spawn errors", async () => {
    await setSlot("default", { apiKey: "op_live_x" });
    adapter.detect.mockResolvedValue({ installed: true });
    adapter.spawn.mockRejectedValue(new Error("spawn died"));
    await expect(
      launchCommand({ agent: "hermes", key: "default" }),
    ).rejects.toThrow("spawn died");
  });

  it("propagates non-zero exit codes from spawn", async () => {
    await setSlot("default", { apiKey: "op_live_x" });
    adapter.detect.mockResolvedValue({ installed: true });
    adapter.spawn.mockResolvedValue(-1);
    const code = await launchCommand({ agent: "hermes", key: "default" });
    expect(code).toBe(-1);
  });

  it("rejects launching a configure-only adapter", async () => {
    const editorAdapter = {
      name: "editor-only",
      displayName: "Editor Only",
      docsUrl: "https://example.com",
      detect: vi.fn().mockResolvedValue({ installed: true }),
      isConfigured: vi.fn(),
      configure: vi.fn(),
      unconfigure: vi.fn(),
      // no spawn → not launchable
    };
    getAdapterMock.mockImplementationOnce((name: string) =>
      name === "editor-only" ? (editorAdapter as unknown as typeof adapter) : null,
    );
    await expect(
      launchCommand({ agent: "editor-only", key: "default" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });
});
