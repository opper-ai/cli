import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const postMock = vi.fn();
vi.mock("../../src/api/client.js", () => ({
  OpperApi: vi.fn().mockImplementation(() => ({
    post: postMock,
    stream: vi.fn(),
  })),
}));

const { callCommand } = await import("../../src/commands/call.js");

useTempOpperHome();

describe("callCommand", () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it("posts to /v3/call with name, instructions, input", async () => {
    await setSlot("default", { apiKey: "op_live_x" });
    postMock.mockResolvedValue({
      data: "hello world",
      meta: { function_name: "greet" },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await callCommand({
        name: "greet",
        instructions: "say hi",
        input: "world",
        key: "default",
      });
      expect(postMock).toHaveBeenCalledWith(
        "/v3/call",
        expect.objectContaining({
          name: "greet",
          instructions: "say hi",
          input: "world",
        }),
      );
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("hello world");
    } finally {
      log.mockRestore();
    }
  });

  it("passes --model through", async () => {
    await setSlot("default", { apiKey: "k" });
    postMock.mockResolvedValue({ data: "x" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await callCommand({
        name: "f",
        instructions: "i",
        input: "in",
        key: "default",
        model: "anthropic/claude-opus-4.7",
      });
      expect(postMock).toHaveBeenCalledWith(
        "/v3/call",
        expect.objectContaining({ model: "anthropic/claude-opus-4.7" }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it("pretty-prints object data as JSON", async () => {
    await setSlot("default", { apiKey: "k" });
    postMock.mockResolvedValue({ data: { score: 0.99, tag: "ok" } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await callCommand({ name: "f", instructions: "i", input: "x", key: "default" });
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("\"score\": 0.99");
      expect(out).toContain("\"tag\": \"ok\"");
    } finally {
      log.mockRestore();
    }
  });
});
