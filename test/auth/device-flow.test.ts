import { describe, it, expect, vi, beforeEach } from "vitest";

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
import { OpperLogin } from "@opperai/login";

describe("runDeviceFlow", () => {
  beforeEach(() => {
    vi.mocked(OpperLogin).mockClear();
    startDeviceAuth.mockReset();
    pollDeviceToken.mockReset();
  });

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
      credentialId: "key-123",
      orgId: 42,
      projectId: 7,
      projectUuid: "project-uuid",
      projectName: "Agent sandbox",
      expiresAt: "2026-10-24T11:00:00Z",
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
    expect(result).toMatchObject({
      credentialId: "key-123",
      orgId: 42,
      projectId: 7,
      projectUuid: "project-uuid",
      projectName: "Agent sandbox",
      expiresAt: "2026-10-24T11:00:00Z",
    });
    expect(result.source).toBe("device-flow");
    expect(typeof result.obtainedAt).toBe("string");

    expect(OpperLogin).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "opper_app_CK-rOJsIIPXlzYYE7MWFCQ" }),
    );
    const args = vi.mocked(OpperLogin).mock.calls[0]?.[0];
    expect(args).not.toHaveProperty("opperUrl");
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

    expect(OpperLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "opper_app_CK-rOJsIIPXlzYYE7MWFCQ",
        opperUrl: "https://custom.example",
      }),
    );
  });

  it("passes explicit renewal intent and the stored credential ID", async () => {
    startDeviceAuth.mockResolvedValue({
      deviceCode: "dc", userCode: "x", verificationUri: "x", expiresIn: 600, interval: 5,
    });
    pollDeviceToken.mockResolvedValue({ apiKey: "op_live_new", user: { email: "a", name: "b" } });

    await runDeviceFlow({ renew: true, currentCredentialId: "key-old" });
    expect(startDeviceAuth).toHaveBeenCalledWith({ renew: true, currentCredentialId: "key-old" });
  });

  it("stores an organization personal credential without inventing a project binding", async () => {
    startDeviceAuth.mockResolvedValue({ deviceCode: "dc", userCode: "x", verificationUri: "x", expiresIn: 600, interval: 0 });
    pollDeviceToken.mockResolvedValue({ apiKey: "org-key", orgId: 42, credentialId: "key-org", projectId: null, projectUuid: null, projectName: null, user: { email: "a" } });
    const result = await runDeviceFlow();
    expect(result).toMatchObject({ apiKey: "org-key", orgId: 42, credentialId: "key-org", source: "device-flow" });
    expect(result).not.toHaveProperty("projectUuid");
    expect(result).not.toHaveProperty("projectId");
    expect(result).not.toHaveProperty("defaultProjectUuid");
  });
});
