import { describe, it, expect, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";

const mocks = {
  configureOpenCode: vi.fn(),
};

vi.mock("../../src/setup/opencode.js", () => ({
  configureOpenCode: mocks.configureOpenCode,
}));

const { editorsListCommand, editorsOpenCodeCommand } = await import(
  "../../src/commands/editors.js"
);

useTempOpperHome();

describe("editors commands", () => {
  it("list prints a placeholder message when no editor-only adapters are registered", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await editorsListCommand();
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      // OpenCode is launchable so it shows up under `opper agents list`,
      // and Continue.dev was removed — list should report empty.
      expect(out.toLowerCase()).toContain("no editor integrations");
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

  it("opencode forwards --overwrite", async () => {
    mocks.configureOpenCode.mockResolvedValue({
      path: "/tmp/opencode.json",
      wrote: true,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await editorsOpenCodeCommand({ location: "global", overwrite: true });
      expect(mocks.configureOpenCode).toHaveBeenCalledWith({
        location: "global",
        overwrite: true,
      });
    } finally {
      log.mockRestore();
    }
  });
});
