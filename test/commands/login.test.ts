import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { readConfig } from "../../src/auth/config.js";

// Capture clack messages so we can assert on them. The real clack writes
// styled output to stdout via process.stdout.write — mocking flattens that
// to plain string capture.
const clackMessages: string[] = [];

vi.mock("@clack/prompts", async () => {
  const actual = await vi.importActual<typeof import("@clack/prompts")>(
    "@clack/prompts",
  );
  const push = (msg: unknown) => clackMessages.push(String(msg));
  return {
    ...actual,
    intro: vi.fn(push),
    outro: vi.fn(push),
    note: vi.fn((msg: string, _title?: string) => push(msg)),
    log: {
      info: vi.fn(push),
      success: vi.fn(push),
      warn: vi.fn(push),
      error: vi.fn(push),
    },
    spinner: vi.fn(() => ({
      start: vi.fn(push),
      stop: vi.fn(push),
      message: vi.fn(),
    })),
    isCancel: (v: unknown) => typeof v === "symbol",
    cancel: vi.fn(push),
  };
});

// Mock device flow.
vi.mock("../../src/auth/device-flow.js", () => ({
  runDeviceFlow: vi.fn(),
}));

const { runDeviceFlow } = await import("../../src/auth/device-flow.js");
const { loginCommand } = await import("../../src/commands/login.js");

useTempOpperHome();

describe("login", () => {
  beforeEach(() => {
    clackMessages.length = 0;
  });

  it("writes the slot returned by the device flow", async () => {
    vi.mocked(runDeviceFlow).mockResolvedValue({
      apiKey: "op_live_xyz",
      user: { email: "me@example.com", name: "Me" },
      obtainedAt: "2026-04-21T11:00:00Z",
      source: "device-flow",
    });
    await loginCommand({ key: "default", legacyPath: "/nonexistent" });
    const cfg = await readConfig();
    expect(cfg?.keys.default?.apiKey).toBe("op_live_xyz");
    expect(cfg?.keys.default?.user?.email).toBe("me@example.com");
    const out = clackMessages.join("\n");
    expect(out).toContain("me@example.com");
  });

  it("short-circuits when slot already has a key", async () => {
    const { setSlot } = await import("../../src/auth/config.js");
    await setSlot("default", { apiKey: "op_live_existing" });
    vi.mocked(runDeviceFlow).mockClear();
    await loginCommand({ key: "default", legacyPath: "/nonexistent" });
    expect(runDeviceFlow).not.toHaveBeenCalled();
    const out = clackMessages.join("\n");
    expect(out.toLowerCase()).toContain("already");
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
    await loginCommand({ key: "default", force: true, legacyPath: "/nonexistent" });
    expect(runDeviceFlow).toHaveBeenCalled();
    const cfg = await readConfig();
    expect(cfg?.keys.default?.apiKey).toBe("op_live_new");
  });

  it("runs legacy migration before prompting if legacy file exists and new config missing", async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const legacyDir = mkdtempSync(join(tmpdir(), "opper-legacy-login-"));
    const legacyPath = join(legacyDir, ".oppercli");
    try {
      writeFileSync(
        legacyPath,
        "api_keys:\n  default:\n    key: op_live_legacy\n",
        "utf8",
      );
      vi.mocked(runDeviceFlow).mockClear();
      await loginCommand({ key: "default", legacyPath });
      // Migration populated the slot — device flow should not run.
      expect(runDeviceFlow).not.toHaveBeenCalled();
      const cfg = await readConfig();
      expect(cfg?.keys.default?.apiKey).toBe("op_live_legacy");
      const out = clackMessages.join("\n");
      expect(out.toLowerCase()).toContain("already");
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("renders the device-flow URL and code via clack note", async () => {
    vi.mocked(runDeviceFlow).mockImplementation(async (opts) => {
      opts?.onPrompt?.({
        userCode: "ABCD-1234",
        verificationUri: "https://platform.opper.ai/device",
        verificationUriComplete: "https://platform.opper.ai/device?user_code=ABCD-1234",
        expiresIn: 600,
      });
      return {
        apiKey: "op_live_z",
        user: { email: "me@example.com", name: "Me" },
        obtainedAt: "2026-04-21T11:00:00Z",
        source: "device-flow",
      };
    });
    await loginCommand({ key: "default", legacyPath: "/nonexistent" });
    const out = clackMessages.join("\n");
    expect(out).toContain("ABCD-1234");
    expect(out).toContain("platform.opper.ai/device");
  });
});
