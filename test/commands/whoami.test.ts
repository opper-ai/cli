import { describe, it, expect, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";
import { whoamiCommand } from "../../src/commands/whoami.js";

useTempOpperHome();

describe("whoami", () => {
  it("prints slot info when logged in", async () => {
    await setSlot("default", {
      apiKey: "op_live_abc123def456",
      user: { email: "me@example.com", name: "Me" },
      obtainedAt: "2026-04-21T11:00:00Z",
      source: "device-flow",
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await whoamiCommand({ key: "default" });
      const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("me@example.com");
      expect(out).toContain("Me");
      expect(out).toContain("default");
      expect(out).toContain("op_live_a"); // fingerprint prefix
      expect(out).not.toContain("op_live_abc123def456"); // full key hidden
    } finally {
      spy.mockRestore();
    }
  });

  it("throws AUTH_REQUIRED when slot missing", async () => {
    await expect(whoamiCommand({ key: "default" })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });
});
