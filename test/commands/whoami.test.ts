import { afterEach, describe, it, expect, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";
import { whoamiCommand } from "../../src/commands/whoami.js";

useTempOpperHome();
afterEach(() => vi.unstubAllEnvs());

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

  it("shows the server-issued expiry and expired state", async () => {
    await setSlot("default", {
      apiKey: "op_live_expired",
      credentialId: "key-123",
      orgId: 42,
      projectName: "Agent sandbox",
      projectUuid: "project-uuid",
      expiresAt: "2020-01-01T00:00:00Z",
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await whoamiCommand({ key: "default" });
      const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("2020-01-01T00:00:00Z");
      expect(out).toContain("expired");
      expect(out).toContain("42");
      expect(out).toContain("key-123");
      expect(out).toContain("Agent sandbox");
    } finally {
      spy.mockRestore();
    }
  });
});

it("shows effective environment credentials without borrowing saved account metadata", async () => {
  await setSlot("default", { apiKey: "saved-secret", user: { email: "saved@example.com", name: "Saved" }, baseUrl: "https://api.opper.ai" });
  vi.stubEnv("OPPER_API_KEY", "synthetic-env-secret");
  vi.stubEnv("OPPER_DEPLOYMENT", "evroc");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await whoamiCommand({ key: "default" });
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("OPPER_API_KEY");
    expect(output).toContain("evroc");
    expect(output).toContain("https://api.evroc.on.opper.ai");
    expect(output).not.toContain("saved@example.com");
    expect(output).not.toContain("synthetic-env-secret");
  } finally { log.mockRestore(); }
});
