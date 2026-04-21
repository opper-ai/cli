import { describe, it, expect, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { readConfig } from "../../src/auth/config.js";

// Mock device flow.
vi.mock("../../src/auth/device-flow.js", () => ({
  runDeviceFlow: vi.fn(),
}));

const { runDeviceFlow } = await import("../../src/auth/device-flow.js");
const { loginCommand } = await import("../../src/commands/login.js");

useTempOpperHome();

describe("login", () => {
  it("writes the slot returned by the device flow", async () => {
    vi.mocked(runDeviceFlow).mockResolvedValue({
      apiKey: "op_live_xyz",
      user: { email: "me@example.com", name: "Me" },
      obtainedAt: "2026-04-21T11:00:00Z",
      source: "device-flow",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await loginCommand({ key: "default" });
      const cfg = await readConfig();
      expect(cfg?.keys.default?.apiKey).toBe("op_live_xyz");
      expect(cfg?.keys.default?.user?.email).toBe("me@example.com");
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("me@example.com");
    } finally {
      log.mockRestore();
    }
  });

  it("short-circuits when slot already has a key", async () => {
    const { setSlot } = await import("../../src/auth/config.js");
    await setSlot("default", { apiKey: "op_live_existing" });
    vi.mocked(runDeviceFlow).mockClear();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await loginCommand({ key: "default" });
      expect(runDeviceFlow).not.toHaveBeenCalled();
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out.toLowerCase()).toContain("already");
    } finally {
      log.mockRestore();
    }
  });

  it("force flag re-runs the flow", async () => {
    const { setSlot } = await import("../../src/auth/config.js");
    await setSlot("default", { apiKey: "op_live_old" });
    vi.mocked(runDeviceFlow).mockClear();
    vi.mocked(runDeviceFlow).mockResolvedValue({
      apiKey: "op_live_new",
      user: { email: "me@example.com", name: "Me" },
      obtainedAt: "2026-04-21T11:00:00Z",
      source: "device-flow",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await loginCommand({ key: "default", force: true });
      expect(runDeviceFlow).toHaveBeenCalled();
      const cfg = await readConfig();
      expect(cfg?.keys.default?.apiKey).toBe("op_live_new");
    } finally {
      log.mockRestore();
    }
  });
});
