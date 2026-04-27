import { describe, it, expect, vi } from "vitest";

const hermesDetect = vi.fn();
const hermesIsConfigured = vi.fn().mockResolvedValue(false);
vi.mock("../../src/agents/registry.js", () => ({
  listAdapters: () => [
    {
      name: "hermes",
      displayName: "Hermes Agent",
      binary: "hermes",
      docsUrl: "https://hermes-agent.nousresearch.com/docs/",
      launchable: true,
      detect: hermesDetect,
      isConfigured: hermesIsConfigured,
      configure: vi.fn(),
      install: vi.fn(),
      snapshotConfig: vi.fn(),
      writeOpperConfig: vi.fn(),
      restoreConfig: vi.fn(),
      spawn: vi.fn(),
    },
  ],
  getAdapter: vi.fn(),
}));

const { agentsListCommand } = await import("../../src/commands/agents.js");

describe("agentsListCommand", () => {
  it("prints each adapter with installed status", async () => {
    hermesDetect.mockResolvedValue({
      installed: true,
      version: "1.0.0",
      configPath: "/home/user/.hermes/config.yaml",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await agentsListCommand();
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("Hermes Agent");
      expect(out).toContain("1.0.0");
      expect(out.toLowerCase()).toContain("installed");
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
