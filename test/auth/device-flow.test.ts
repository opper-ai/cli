import { describe, it, expect, vi } from "vitest";

// Mock @opperai/login before importing our wrapper.
const startDeviceAuth = vi.fn();
const pollDeviceToken = vi.fn();

vi.mock("@opperai/login", () => ({
  OpperLogin: vi.fn().mockImplementation(() => ({
    startDeviceAuth,
    pollDeviceToken,
  })),
}));

const { runDeviceFlow } = await import("../../src/auth/device-flow.js");

describe("runDeviceFlow", () => {
  it("calls startDeviceAuth then pollDeviceToken with the result", async () => {
    startDeviceAuth.mockResolvedValue({
      deviceCode: "dc",
      userCode: "ABCD-1234",
      verificationUri: "https://platform.opper.ai/device",
      verificationUriComplete: "https://platform.opper.ai/device?user_code=ABCD-1234",
      expiresIn: 600,
      interval: 5,
    });
    pollDeviceToken.mockResolvedValue({
      apiKey: "op_live_abc",
      user: { email: "me@example.com", name: "Me" },
    });

    const onPrompt = vi.fn();
    const result = await runDeviceFlow({ onPrompt });

    expect(startDeviceAuth).toHaveBeenCalled();
    expect(pollDeviceToken).toHaveBeenCalledWith(
      expect.objectContaining({ userCode: "ABCD-1234" }),
    );
    expect(onPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ userCode: "ABCD-1234" }),
    );
    expect(result.apiKey).toBe("op_live_abc");
    expect(result.user).toEqual({ email: "me@example.com", name: "Me" });
    expect(result.source).toBe("device-flow");
    expect(typeof result.obtainedAt).toBe("string");
  });

  it("accepts a baseUrl override passed to OpperLogin", async () => {
    startDeviceAuth.mockResolvedValue({
      deviceCode: "dc",
      userCode: "x",
      verificationUri: "x",
      expiresIn: 600,
      interval: 5,
    });
    pollDeviceToken.mockResolvedValue({
      apiKey: "k",
      user: { email: "a", name: "b" },
    });
    const result = await runDeviceFlow({ baseUrl: "https://custom.example" });
    expect(result.baseUrl).toBe("https://custom.example");
  });
});
