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

  it("MCP setup preserves inference and does not resolve a model catalog or log in", async () => {
    mocks.resolveOpenCodeModels.mockClear();
    mocks.configureOpenCode.mockResolvedValue({ path: "/tmp/opencode.jsonc", wrote: true, mcpName: "opper", mcpEnabled: true });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await editorsOpenCodeCommand({ location: "local", overwrite: false, mcp: true, mcpUrl: "http://localhost:8080/mcp" });
      expect(mocks.resolveOpenCodeModels).not.toHaveBeenCalled();
      expect(mocks.configureOpenCode).toHaveBeenLastCalledWith({ location: "local", mcp: true, mcpUrl: "http://localhost:8080/mcp" });
      const output = log.mock.calls.map(([message]) => message).join("\n");
      expect(output).toContain("opper");
      expect(output).toMatch(/browser/i);
      expect(output).toMatch(/restart|reopen/i);
    } finally { log.mockRestore(); }
  });

  it("reports an existing disabled connection without enabling it", async () => {
    mocks.configureOpenCode.mockResolvedValue({ path: "/tmp/opencode.json", wrote: false, reason: "exists", mcpName: "opper_demo", mcpEnabled: false });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await editorsOpenCodeCommand({ location: "global", overwrite: false, mcp: true });
      const output = log.mock.calls.map(([message]) => message).join("\n");
      expect(output).toContain("opper_demo");
      expect(output).toContain("disabled");
      expect(output).not.toContain("--overwrite");
    } finally { log.mockRestore(); }
  });

  it("forwards explicit MCP scopes and explains that updated config still needs browser consent", async () => {
    mocks.configureOpenCode.mockResolvedValue({ path: "/tmp/opencode.jsonc", wrote: true, mcpName: "opper_demo", mcpEnabled: true, mcpScopes: "account:read projects:write" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await editorsOpenCodeCommand({ location: "global", overwrite: false, mcp: true, mcpScopes: "account:read projects:write" });
      expect(mocks.configureOpenCode).toHaveBeenLastCalledWith({ location: "global", mcp: true, mcpScopes: "account:read projects:write" });
      const output = log.mock.calls.map(([message]) => message).join("\n");
      expect(output).toContain("account:read projects:write");
      expect(output).toMatch(/browser/i);
      expect(output).toContain("opencode mcp auth opper_demo");
    } finally { log.mockRestore(); }
  });
});
