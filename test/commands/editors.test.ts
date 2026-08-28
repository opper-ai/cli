import { describe, it, expect, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";

const mocks = {
  configureOpenCode: vi.fn(),
  resolveOpenCodeModels: vi.fn(),
};

// Stubbed so the suite makes no network call: resolveOpenCodeModels fetches
// the live catalogue, and a unit test must not depend on a reachable gateway
// or an ambient OPPER_API_KEY.
vi.mock("../../src/setup/opencode-models.js", () => ({
  resolveOpenCodeModels: mocks.resolveOpenCodeModels,
}));

vi.mock("../../src/setup/opencode.js", () => ({
  configureOpenCode: mocks.configureOpenCode,
}));

const { editorsListCommand, editorsOpenCodeCommand } = await import(
  "../../src/commands/editors.js"
);

useTempOpperHome();

describe("editors commands", () => {
  it("list shows the registered configure-only adapters", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await editorsListCommand();
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      // GitHub Copilot (VS Code) is configure-only (no spawn) — should
      // surface here. Launchable adapters live under `opper agents list`.
      expect(out).toContain("GitHub Copilot (VS Code)");
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

  it("opencode writes the live catalogue when it resolves", async () => {
    // `opper editors opencode` is the config-only entry point; it must not
    // quietly fall back to the bundled list while `launch` stays current.
    const models = { "dynamic/my-route": { name: "My Route (route)" } };
    mocks.resolveOpenCodeModels.mockResolvedValue(models);
    mocks.configureOpenCode.mockResolvedValue({
      path: "/tmp/opencode.json",
      wrote: true,
    });
    await editorsOpenCodeCommand({ location: "global", overwrite: false });
    expect(mocks.configureOpenCode).toHaveBeenCalledWith(
      expect.objectContaining({ models }),
    );
    mocks.resolveOpenCodeModels.mockReset();
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
