import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { getSlot, readConfig, setSlot } from "../../src/auth/config.js";

const adapter = vi.hoisted(() => ({
  name: "profile-test", displayName: "Profile test agent", docsUrl: "https://example.invalid",
  detect: vi.fn(), isConfigured: vi.fn(), spawn: vi.fn(),
}));
vi.mock("../../src/agents/registry.js", () => ({ getAdapter: () => adapter, listAdapters: () => [adapter] }));
vi.mock("../../src/api/client.js", () => ({ OpperApi: class { get = vi.fn().mockResolvedValue([]); } }));
vi.mock("../../data/copilot/launch.mjs", () => ({ launchCopilot: vi.fn() }));
vi.mock("../../src/auth/device-flow.js", () => ({ runDeviceFlow: vi.fn() }));
vi.mock("../../src/auth/migrate.js", () => ({ maybeMigrateLegacyConfig: vi.fn().mockResolvedValue(false) }));
vi.mock("../../src/util/open-browser.js", () => ({ openBrowser: vi.fn() }));
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(), outro: vi.fn(), note: vi.fn(), log: { info: vi.fn(), success: vi.fn() },
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }), isCancel: () => false, cancel: vi.fn(),
}));
const { runDeviceFlow } = await import("../../src/auth/device-flow.js");
const { launchCommand } = await import("../../src/commands/launch.js");
const { loginCommand } = await import("../../src/commands/login.js");
const { copilot } = await import("../../src/agents/copilot.js");
const { launchCopilot } = await import("../../data/copilot/launch.mjs");
useTempOpperHome();
beforeEach(() => {
  vi.stubEnv("OPPER_DEPLOYMENT", "evroc");
  vi.stubEnv("OPPER_API_KEY", undefined);
  vi.stubEnv("OPPER_BASE_URL", undefined);
  vi.mocked(runDeviceFlow).mockReset();
  vi.mocked(runDeviceFlow).mockResolvedValue({ apiKey: "synthetic-new-evroc", credentialId: "new-id", orgId: 42, source: "device-flow" });
  adapter.detect.mockReset(); adapter.spawn.mockReset();
  adapter.spawn.mockResolvedValue(0);
});
afterEach(() => vi.unstubAllEnvs());

describe("automatic launch login preserves the saved profile", () => {
  it.each([
    { stored: "missing", hasMain: true, installed: true },
    { stored: "expired", hasMain: true, installed: true },
    { stored: "missing", hasMain: false, installed: true },
    { stored: "missing", hasMain: true, installed: false },
    { stored: "expired", hasMain: true, installed: false },
    { stored: "missing", hasMain: false, installed: false },
  ])("preserves main/default when autoauth is $stored (main=$hasMain, installed=$installed)", async ({ stored, hasMain, installed }) => {
    if (hasMain) await setSlot("main", { apiKey: "synthetic-main", baseUrl: "https://api.opper.ai" });
    if (stored === "expired") await setSlot("evroc", { apiKey: "synthetic-old-evroc", credentialId: "old-id", baseUrl: "https://api.evroc.on.opper.ai", expiresAt: "2020-01-01T00:00:00Z" });
    adapter.detect.mockResolvedValue({ installed });
    const launched = launchCommand({ agent: adapter.name, key: "evroc" });
    if (installed) expect(await launched).toBe(0);
    else await expect(launched).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
    expect((await readConfig())?.defaultKey).toBe(hasMain ? "main" : "default");
    expect((await getSlot("evroc"))?.apiKey).toBe("synthetic-new-evroc");
    if (hasMain) expect((await getSlot("main"))?.apiKey).toBe("synthetic-main");
    expect(runDeviceFlow).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "https://api.evroc.on.opper.ai" }));
    if (stored === "expired") expect(runDeviceFlow).toHaveBeenCalledWith(expect.objectContaining({ renew: true, currentCredentialId: "old-id" }));
    if (installed) expect(adapter.spawn).toHaveBeenCalledWith([], expect.objectContaining({ apiKey: "synthetic-new-evroc", apiBaseUrl: "https://api.evroc.on.opper.ai" }), expect.any(Object));
    else expect(adapter.spawn).not.toHaveBeenCalled();
  });

  it("preserves the active profile during Copilot's rejected-credential recovery", async () => {
    await setSlot("main", { apiKey: "synthetic-main", baseUrl: "https://api.opper.ai" });
    await setSlot("evroc", { apiKey: "synthetic-old-evroc", baseUrl: "https://api.evroc.on.opper.ai" });
    vi.mocked(launchCopilot).mockReset();
    vi.mocked(launchCopilot).mockRejectedValueOnce({ status: 401 }).mockResolvedValueOnce(0);
    const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    try {
      expect(await copilot.spawn!([], { keyName: "evroc", apiBaseUrl: "https://api.evroc.on.opper.ai", baseUrl: "https://api.evroc.on.opper.ai/v3/session/test", apiKey: "synthetic-old-evroc", model: "test-model", compatShape: "openai" })).toBe(0);
    } finally {
      if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    expect(launchCopilot).toHaveBeenCalledTimes(2);
    expect((await readConfig())?.defaultKey).toBe("main");
    expect((await getSlot("evroc"))?.apiKey).toBe("synthetic-new-evroc");
  });

  it("can reuse an existing login without activating it", async () => {
    await setSlot("main", { apiKey: "synthetic-main" });
    await setSlot("evroc", { apiKey: "synthetic-evroc", baseUrl: "https://api.evroc.on.opper.ai" });
    await loginCommand({ key: "evroc", activate: false });
    expect((await readConfig())?.defaultKey).toBe("main");
    expect(runDeviceFlow).not.toHaveBeenCalled();
  });
});
