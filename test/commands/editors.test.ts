import { describe, it, expect, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const mocks = {
  configureOpenCode: vi.fn(),
  configureContinue: vi.fn(),
};

vi.mock("../../src/setup/opencode.js", () => ({
  configureOpenCode: mocks.configureOpenCode,
}));
vi.mock("../../src/setup/continue.js", () => ({
  configureContinue: mocks.configureContinue,
}));

const {
  editorsListCommand,
  editorsOpenCodeCommand,
  editorsContinueCommand,
} = await import("../../src/commands/editors.js");

useTempOpperHome();

describe("editors commands", () => {
  it("list prints each editor with its capability", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await editorsListCommand();
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("OpenCode");
      expect(out).toContain("Continue.dev");
      expect(out).toContain("Cursor");
    } finally {
      log.mockRestore();
    }
  });

  it("opencode delegates to configureOpenCode with the chosen location", async () => {
    mocks.configureOpenCode.mockResolvedValue({
      path: "/tmp/opencode.json",
      wrote: true,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await editorsOpenCodeCommand({ location: "local", overwrite: false });
      expect(mocks.configureOpenCode).toHaveBeenCalledWith({ location: "local" });
    } finally {
      log.mockRestore();
    }
  });

  it("continue requires an authenticated slot for the API key", async () => {
    await expect(
      editorsContinueCommand({ location: "global", overwrite: false, key: "default" }),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("continue passes the slot apiKey to configureContinue", async () => {
    await setSlot("default", { apiKey: "op_live_xyz" });
    mocks.configureContinue.mockResolvedValue({
      path: "/tmp/cfg.yaml",
      wrote: true,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await editorsContinueCommand({ location: "global", overwrite: false, key: "default" });
      expect(mocks.configureContinue).toHaveBeenCalledWith({
        location: "global",
        apiKey: "op_live_xyz",
      });
    } finally {
      log.mockRestore();
    }
  });

  it("continue falls back to OPPER_API_KEY env when no slot is stored", async () => {
    const prev = process.env.OPPER_API_KEY;
    process.env.OPPER_API_KEY = "op_live_env";
    try {
      mocks.configureContinue.mockResolvedValue({ path: "/tmp/cfg.yaml", wrote: true });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await editorsContinueCommand({ location: "global", overwrite: false, key: "default" });
        expect(mocks.configureContinue).toHaveBeenCalledWith({
          location: "global",
          apiKey: "op_live_env",
        });
      } finally {
        log.mockRestore();
      }
    } finally {
      if (prev === undefined) delete process.env.OPPER_API_KEY;
      else process.env.OPPER_API_KEY = prev;
    }
  });
});
