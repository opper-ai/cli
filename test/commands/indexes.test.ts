import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const getMock = vi.fn();
const postMock = vi.fn();
const delMock = vi.fn();
vi.mock("../../src/api/client.js", () => ({
  OpperApi: vi.fn().mockImplementation(() => ({
    get: getMock,
    post: postMock,
    del: delMock,
  })),
}));

const {
  indexesListCommand,
  indexesGetCommand,
} = await import("../../src/commands/indexes.js");

useTempOpperHome();

describe("indexes list + get", () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it("list prints a table of indexes from v2 /knowledge", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({
      meta: { total: 2 },
      data: [
        { id: "k1", name: "product-docs", embedding_model: "m", created_at: "2026-04-21T00:00:00Z" },
        { id: "k2", name: "support-kb", embedding_model: "m", created_at: "2026-04-20T00:00:00Z" },
      ],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await indexesListCommand({ key: "default" });
      expect(getMock).toHaveBeenCalledWith("/v2/knowledge", expect.any(Object));
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("product-docs");
      expect(out).toContain("support-kb");
    } finally {
      log.mockRestore();
    }
  });

  it("get prints index details", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({
      id: "k1",
      name: "product-docs",
      embedding_model: "m",
      created_at: "2026-04-21T00:00:00Z",
      count: 42,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await indexesGetCommand({ name: "product-docs", key: "default" });
      expect(getMock).toHaveBeenCalledWith("/v2/knowledge/by-name/product-docs");
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("product-docs");
      expect(out).toContain("42");
    } finally {
      log.mockRestore();
    }
  });
});
