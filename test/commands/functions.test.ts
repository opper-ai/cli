import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const getMock = vi.fn();
const delMock = vi.fn();
vi.mock("../../src/api/client.js", () => ({
  OpperApi: vi.fn().mockImplementation(() => ({ get: getMock, del: delMock })),
}));

const {
  functionsListCommand,
  functionsGetCommand,
  functionsDeleteCommand,
} = await import("../../src/commands/functions.js");

useTempOpperHome();

describe("functions commands", () => {
  beforeEach(() => {
    getMock.mockReset();
    delMock.mockReset();
  });

  it("list prints a table of function names", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({
      functions: [
        { name: "greet", description: "say hi" },
        { name: "summarize", description: "summarize text" },
      ],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await functionsListCommand({ key: "default" });
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("greet");
      expect(out).toContain("summarize");
      expect(getMock).toHaveBeenCalledWith("/v3/functions");
    } finally {
      log.mockRestore();
    }
  });

  it("get prints function details", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({
      name: "greet",
      description: "say hi",
      instructions: "respond in kind",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await functionsGetCommand({ name: "greet", key: "default" });
      expect(getMock).toHaveBeenCalledWith("/v3/functions/greet");
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("greet");
      expect(out).toContain("respond in kind");
    } finally {
      log.mockRestore();
    }
  });

  it("delete calls DELETE /v3/functions/{name}", async () => {
    await setSlot("default", { apiKey: "k" });
    delMock.mockResolvedValue(undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await functionsDeleteCommand({ name: "greet", key: "default" });
      expect(delMock).toHaveBeenCalledWith("/v3/functions/greet");
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("Deleted");
    } finally {
      log.mockRestore();
    }
  });
});
