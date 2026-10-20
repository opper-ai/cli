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
const desktopPrepareMock = vi.fn();
const desktopOpenMock = vi.fn();
vi.mock("../../src/commands/desktop.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/commands/desktop.js")>(),
  prepareDesktopProxy: desktopPrepareMock, desktopOpenCommand: desktopOpenMock,
}));
vi.mock("../../src/api/client.js", () => ({
  OpperApi: class {
    get = apiGetMock;
  },
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
    desktopPrepareMock.mockReset();
    desktopOpenMock.mockReset().mockResolvedValue({ url: "http://127.0.0.1:12345/open/fresh-ticket" });
  });

  it.each(["codex","codex-desktop","opencode","pi"])("passes full catalog intent to %s",async (agent)=>{
    await setSlot("default",{apiKey:"synthetic"}); adapter.detect.mockResolvedValue({installed:true}); adapter.spawn.mockResolvedValue(0);
    getAdapterMock.mockReturnValueOnce({...adapter,name:agent});
    await launchCommand({agent,key:"default",modelKinds:"all"});
    expect(adapter.spawn.mock.calls[0]![1]).toMatchObject({modelKinds:"all",apiKey:"synthetic"});
  });

  it.each([["hermes","all"],["pi","models"]])("rejects unsupported catalog policy for %s before login",async(agent,modelKinds)=>{
    getAdapterMock.mockReturnValueOnce({...adapter,name:agent});
    await expect(launchCommand({agent,key:"missing",modelKinds})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
    expect(loginMock).not.toHaveBeenCalled(); expect(adapter.spawn).not.toHaveBeenCalled();
  });

  it("keeps desktop launches direct unless --proxy is explicit", async () => {
    await setSlot("default", { apiKey: "real-key" });
    adapter.detect.mockResolvedValue({ installed: true }); adapter.spawn.mockResolvedValue(0);
    getAdapterMock.mockReturnValueOnce({ ...adapter, name: "codex-desktop", launchesInBackground: true });
    await launchCommand({ agent: "codex-desktop", key: "default" });
    expect(desktopPrepareMock).not.toHaveBeenCalled(); expect(desktopOpenMock).not.toHaveBeenCalled();
    expect(adapter.spawn.mock.calls[0]![1]).not.toHaveProperty("desktopProxy");
  });

  it.each([false, true])("skips process-lifetime usage summaries for actual Claude desktop background metadata (proxy=%s)", async (proxy) => {
    const { claudeDesktop } = await import("../../src/agents/claude-desktop.js");
    await setSlot("default", { apiKey: "real-key" });
    adapter.detect.mockResolvedValue({ installed: true });
    desktopPrepareMock.mockResolvedValue({ proxy: { baseUrl: "http://127.0.0.1:12345", token: "local", stateDir: "/tmp/proxy" } });
    getAdapterMock.mockReturnValueOnce({ ...adapter, name: "claude-desktop", launchesInBackground: claudeDesktop.launchesInBackground } as typeof adapter);
    vi.useFakeTimers();
    try {
      adapter.spawn.mockImplementation(async () => { vi.advanceTimersByTime(2000); return 0; });
      await launchCommand({ agent: "claude-desktop", key: "default", proxy });
      expect(apiGetMock).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("ensures the scoped desktop proxy and opens the picker after successful app setup", async () => {
    const projectUuid = "11111111-1111-4111-8111-111111111111";
    const proxy = { baseUrl: "http://127.0.0.1:12345", token: "local-token", stateDir: "/tmp/proxy" };
    desktopPrepareMock.mockResolvedValue({ proxy });
    await setSlot("default", { apiKey: "real-key", baseUrl: "https://api.opper.ai" });
    adapter.detect.mockResolvedValue({ installed: true }); adapter.spawn.mockResolvedValue(0);
    getAdapterMock.mockReturnValueOnce({ ...adapter, name: "codex-desktop", launchesInBackground: true });
    expect(await launchCommand({ agent: "codex-desktop", key: "default", proxy: true, stateDir: "/tmp/proxy", codexHome: "/tmp/home", projectUuid })).toBe(0);
    expect(desktopPrepareMock).toHaveBeenCalledExactlyOnceWith({ key: "default", stateDir: "/tmp/proxy", projectUuid });
    expect(adapter.spawn).toHaveBeenCalledWith([], expect.objectContaining({ desktopProxy: proxy, apiBaseUrl: "https://api.opper.ai", apiKey: "real-key", projectUuid }), { codexHome: "/tmp/home" });
    expect(desktopOpenMock).toHaveBeenCalledExactlyOnceWith({ key: "default", stateDir: proxy.stateDir, projectUuid });
    expect(adapter.spawn.mock.invocationCallOrder[0]).toBeLessThan(desktopOpenMock.mock.invocationCallOrder[0]!);
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it("does not launch an app when its bound proxy cannot start", async () => {
    await setSlot("default", { apiKey: "real-key" });
    adapter.detect.mockResolvedValue({ installed: true });
    getAdapterMock.mockReturnValueOnce({ ...adapter, name: "claude-desktop", launchesInBackground: true });
    desktopPrepareMock.mockRejectedValue(new Error("owner changed"));
    await expect(launchCommand({ agent: "claude-desktop", key: "default", proxy: true })).rejects.toThrow("owner changed");
    expect(adapter.spawn).not.toHaveBeenCalled(); expect(desktopOpenMock).not.toHaveBeenCalled();
  });

  it.each([
    { agent: "hermes", proxy: true },
    { agent: "hermes", stateDir: "/tmp/proxy" },
    { agent: "codex-desktop", proxy: true, tags: { project: "acme" } },
  ])("rejects ambiguous or unsupported proxy options before login (%j)", async (options) => {
    getAdapterMock.mockReturnValueOnce({ ...adapter, name: options.agent });
    await expect(launchCommand({ key: "missing", ...options })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(loginMock).not.toHaveBeenCalled(); expect(desktopPrepareMock).not.toHaveBeenCalled(); expect(adapter.spawn).not.toHaveBeenCalled();
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

  it("re-authenticates an expired slot before launching", async () => {
    await setSlot("default", { apiKey: "op_live_old", expiresAt: "2020-01-01T00:00:00Z" });
    adapter.detect.mockResolvedValue({ installed: true });
    adapter.spawn.mockResolvedValue(0);
    loginMock.mockImplementation(async () => {
      await setSlot("default", { apiKey: "op_live_new", expiresAt: "2030-01-01T00:00:00Z" });
    });

    await launchCommand({ agent: "hermes", key: "default" });
    expect(loginMock).toHaveBeenCalledWith({ key: "default" });
    expect(adapter.spawn).toHaveBeenCalledWith(
      [], expect.objectContaining({ apiKey: "op_live_new" }), expect.any(Object),
    );
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

  it("uses Claude Opus 5 as the default launch model", async () => {
    await setSlot("default", { apiKey: "op_live_happy" });
    adapter.detect.mockResolvedValue({ installed: true });
    adapter.spawn.mockResolvedValue(0);

    await launchCommand({ agent: "hermes", key: "default" });

    expect(adapter.spawn).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ model: "claude-opus-5" }),
      expect.any(Object),
    );
  });

  it("rejects a model outside an adapter's declared supported list", async () => {
    const restrictedAdapter = {
      ...adapter,
      name: "claude-desktop",
      displayName: "Claude Desktop",
      supportsModel: (modelId: string) => /^(?!dynamic\/)(?:[^/]+\/)*claude-/.test(modelId),
      modelSupportHint: "Use a claude-* pool or provider/claude-* route (not dynamic/*).",
    };
    getAdapterMock.mockImplementationOnce((name: string) =>
      name === "claude-desktop" ? restrictedAdapter : null,
    );
    await setSlot("default", { apiKey: "op_live_happy" });
    restrictedAdapter.detect.mockResolvedValue({ installed: true });

    await expect(launchCommand({
      agent: "claude-desktop",
      key: "default",
      model: "gpt-5.5",
    })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining("gpt-5.5"),
      hint: expect.stringContaining("provider/claude-*"),
    });
    expect(restrictedAdapter.spawn).not.toHaveBeenCalled();
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

  it("forwards an explicit desktop home through spawn options without changing CODEX_HOME", async () => {
    const desktop = { ...adapter, name: "codex-desktop", launchesInBackground: true };
    getAdapterMock.mockReturnValueOnce(desktop);
    await setSlot("prod", { apiKey: "fixture-prod" });
    adapter.detect.mockResolvedValue({ installed: true });
    adapter.spawn.mockResolvedValue(0);
    const homeBefore = process.env.CODEX_HOME;

    await launchCommand({ agent: "codex-desktop", key: "prod", codexHome: "/tmp/selected Codex home" });

    expect(adapter.spawn).toHaveBeenCalledExactlyOnceWith([], expect.objectContaining({ keyName: "prod" }), {
      codexHome: "/tmp/selected Codex home",
    });
    expect(process.env.CODEX_HOME).toBe(homeBefore);
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it("rejects --codex-home for other adapters before login, detection or installation", async () => {
    await expect(launchCommand({ agent: "hermes", key: "missing", install: true, codexHome: "/tmp/custom" }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT", message: expect.stringContaining("--codex-home") });
    expect(loginMock).not.toHaveBeenCalled();
    expect(adapter.detect).not.toHaveBeenCalled();
    expect(adapter.install).not.toHaveBeenCalled();
    expect(adapter.spawn).not.toHaveBeenCalled();
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
