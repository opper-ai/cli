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

const apiGetMock = vi.fn().mockResolvedValue([]);
vi.mock("../../src/api/client.js", () => ({
  OpperApi: class {
    get = apiGetMock;
  },
}));
vi.mock("../../src/api/resolve.js", () => ({
  resolveApiContext: vi.fn().mockResolvedValue({
    apiKey: "op_live_x",
    baseUrl: "https://api.opper.ai",
  }),
}));

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
    apiGetMock.mockClear();
    apiGetMock.mockResolvedValue([]);
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
      expect.any(Object),
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
      model: "claude-opus-4-7",
      passthrough: ["chat", "hi"],
    });

    expect(code).toBe(0);
    expect(adapter.spawn).toHaveBeenCalledWith(
      ["chat", "hi"],
      expect.objectContaining({
        apiKey: "op_live_happy",
        model: "claude-opus-4-7",
        compatShape: "openai",
      }),
      expect.any(Object),
    );
  });

  it("forwards configScope=project to spawn", async () => {
    await setSlot("default", { apiKey: "op_live_p" });
    adapter.detect.mockResolvedValue({ installed: true });
    adapter.spawn.mockResolvedValue(0);

    await launchCommand({
      agent: "hermes",
      key: "default",
      configScope: "project",
    });

    expect(adapter.spawn).toHaveBeenCalledWith(
      [],
      expect.any(Object),
      expect.objectContaining({ configScope: "project" }),
    );
  });

  it("does not set configScope=project when --project wasn't passed", async () => {
    await setSlot("default", { apiKey: "op_live_n" });
    adapter.detect.mockResolvedValue({ installed: true });
    adapter.spawn.mockResolvedValue(0);

    await launchCommand({ agent: "hermes", key: "default" });

    const lastCall = adapter.spawn.mock.calls.at(-1)!;
    expect(lastCall[2]).not.toMatchObject({ configScope: "project" });
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

  it("includes a session prefix in routing.baseUrl with no tags", async () => {
    await setSlot("default", { apiKey: "op_live_x" });
    adapter.detect.mockResolvedValue({ installed: true });
    adapter.spawn.mockResolvedValue(0);

    await launchCommand({ agent: "hermes", key: "default" });

    const arg = adapter.spawn.mock.calls[0][1] as { baseUrl: string };
    expect(arg.baseUrl).toMatch(
      /^https:\/\/api\.opper\.ai\/v3\/session\/sess_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("appends --tag pairs to routing.baseUrl in alphabetical order", async () => {
    await setSlot("default", { apiKey: "op_live_x" });
    adapter.detect.mockResolvedValue({ installed: true });
    adapter.spawn.mockResolvedValue(0);

    await launchCommand({
      agent: "hermes",
      key: "default",
      tags: { team: "eu", customer: "acme" }, // intentionally unsorted
    });

    const arg = adapter.spawn.mock.calls[0][1] as { baseUrl: string };
    expect(arg.baseUrl).toMatch(
      /\/v3\/session\/sess_[0-9a-f-]{36}\/customer:acme\/team:eu$/,
    );
  });

  it("rejects invalid --tag keys before spawning", async () => {
    await setSlot("default", { apiKey: "op_live_x" });
    adapter.detect.mockResolvedValue({ installed: true });

    await expect(
      launchCommand({
        agent: "hermes",
        key: "default",
        tags: { "1bad": "v" },
      }),
    ).rejects.toThrow(/invalid tag key/);
    expect(adapter.spawn).not.toHaveBeenCalled();
  });

  it("respects slot.baseUrl when set", async () => {
    await setSlot("default", { apiKey: "op_live_x", baseUrl: "https://staging.opper.ai" });
    adapter.detect.mockResolvedValue({ installed: true });
    adapter.spawn.mockResolvedValue(0);

    await launchCommand({ agent: "hermes", key: "default" });

    const arg = adapter.spawn.mock.calls[0][1] as { baseUrl: string };
    expect(arg.baseUrl.startsWith("https://staging.opper.ai/v3/session/sess_")).toBe(true);
  });

  it("queries /v2/analytics/usage with session_id and no date window", async () => {
    await setSlot("default", { apiKey: "op_live_x" });
    adapter.detect.mockResolvedValue({ installed: true });
    // Make sure the session is long enough to pass the durationMs >= 1500 guard.
    adapter.spawn.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 1600));
      return 0;
    });

    await launchCommand({ agent: "hermes", key: "default" });

    // The first /v2/analytics/usage call is the summary.
    const usageCall = apiGetMock.mock.calls.find(
      ([path]) => path === "/v2/analytics/usage",
    );
    expect(usageCall).toBeDefined();
    const [, query] = usageCall!;
    expect(query.session_id).toMatch(/^sess_[0-9a-f-]{36}$/);
    expect(query.granularity).toBe("minute");
    expect(query.group_by).toBe("model");
    expect(query).not.toHaveProperty("from_date");
    expect(query).not.toHaveProperty("to_date");
  });

  it("skips the summary for very short sessions", async () => {
    await setSlot("default", { apiKey: "op_live_x" });
    adapter.detect.mockResolvedValue({ installed: true });
    adapter.spawn.mockResolvedValue(0); // exits immediately, < 1500ms

    await launchCommand({ agent: "hermes", key: "default" });

    expect(apiGetMock).not.toHaveBeenCalled();
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
