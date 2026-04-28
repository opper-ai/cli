import { describe, it, expect, vi } from "vitest";

const hermesDetect = vi.fn();
const hermesIsConfigured = vi.fn().mockResolvedValue(false);
vi.mock("../../src/agents/registry.js", () => ({
  listAdapters: () => [
    {
      name: "hermes",
      displayName: "Hermes Agent",
      docsUrl: "https://hermes-agent.nousresearch.com/docs/",
      detect: hermesDetect,
      isConfigured: hermesIsConfigured,
      configure: vi.fn(),
      unconfigure: vi.fn(),
      install: vi.fn(),
      spawn: vi.fn(),
    },
  ],
  getAdapter: vi.fn(),
}));

const { agentsListCommand } = await import("../../src/commands/agents.js");

describe("agentsListCommand", () => {
  it("prints each adapter with installed status, slug, and launch command", async () => {
    hermesDetect.mockResolvedValue({
      installed: true,
      version: "1.0.0",
      configPath: "/home/user/.hermes/config.yaml",
    });
    hermesIsConfigured.mockResolvedValue(true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await agentsListCommand();
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("hermes"); // slug column
      expect(out).toContain("Hermes Agent"); // display name
      expect(out).toContain("1.0.0"); // version inline
      expect(out.toLowerCase()).toContain("installed");
      expect(out).toContain("opper launch hermes"); // launch command shown per row
    } finally {
      log.mockRestore();
    }
  });

  it("marks adapters as not installed when detect() says so", async () => {
    hermesDetect.mockResolvedValue({ installed: false });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await agentsListCommand();
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out.toLowerCase()).toContain("not installed");
    } finally {
      log.mockRestore();
    }
  });
});
