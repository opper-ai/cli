import { describe, it, expect, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const getMock = vi.fn();
vi.mock("../../src/api/client.js", () => ({
  OpperApi: vi.fn().mockImplementation(() => ({ get: getMock })),
}));

const { modelsListCommand } = await import("../../src/commands/models.js");

useTempOpperHome();

describe("modelsListCommand", () => {
  it("prints a table of model name, id, context_window", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({
      models: [
        { name: "Claude Opus 4.7", id: "anthropic/claude-opus-4.7", context_window: 200000 },
        { name: "GPT-4o", id: "openai/gpt-4o", context_window: 128000 },
      ],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await modelsListCommand({ key: "default" });
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("anthropic/claude-opus-4.7");
      expect(out).toContain("openai/gpt-4o");
      expect(getMock).toHaveBeenCalledWith("/v3/models");
    } finally {
      log.mockRestore();
    }
  });

  it("filters by substring match on name or id", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({
      models: [
        { name: "Claude Opus", id: "anthropic/claude-opus-4.7", context_window: 1 },
        { name: "GPT-4o", id: "openai/gpt-4o", context_window: 1 },
      ],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await modelsListCommand({ key: "default", filter: "claude" });
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("anthropic/claude-opus-4.7");
      expect(out).not.toContain("openai/gpt-4o");
    } finally {
      log.mockRestore();
    }
  });
});
