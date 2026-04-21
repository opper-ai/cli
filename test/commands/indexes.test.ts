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

describe("indexes create + delete", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    delMock.mockReset();
  });

  it("create posts to /v2/knowledge with the name", async () => {
    await setSlot("default", { apiKey: "k" });
    postMock.mockResolvedValue({
      id: "k_new",
      name: "product-docs",
      embedding_model: "opper/default",
      created_at: "2026-04-21T00:00:00Z",
    });
    const { indexesCreateCommand } = await import("../../src/commands/indexes.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await indexesCreateCommand({ name: "product-docs", key: "default" });
      expect(postMock).toHaveBeenCalledWith(
        "/v2/knowledge",
        expect.objectContaining({ name: "product-docs" }),
      );
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("product-docs");
      expect(out).toContain("k_new");
    } finally {
      log.mockRestore();
    }
  });

  it("delete looks up by name, then DELETEs by id", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({
      id: "k_abc",
      name: "product-docs",
      embedding_model: "m",
    });
    delMock.mockResolvedValue(undefined);
    const { indexesDeleteCommand } = await import("../../src/commands/indexes.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await indexesDeleteCommand({ name: "product-docs", key: "default" });
      expect(getMock).toHaveBeenCalledWith("/v2/knowledge/by-name/product-docs");
      expect(delMock).toHaveBeenCalledWith("/v2/knowledge/k_abc");
    } finally {
      log.mockRestore();
    }
  });
});

describe("indexes query", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it("query looks up by name then POSTs to /v2/knowledge/{id}/query", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({ id: "k_abc", name: "docs" });
    postMock.mockResolvedValue([
      { score: 0.92, content: "The quick brown fox", key: "doc1" },
      { score: 0.81, content: "Lazy dogs sleep", key: "doc2" },
    ]);
    const { indexesQueryCommand } = await import("../../src/commands/indexes.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await indexesQueryCommand({
        name: "docs",
        query: "foxes",
        topK: 5,
        key: "default",
      });
      expect(postMock).toHaveBeenCalledWith(
        "/v2/knowledge/k_abc/query",
        expect.objectContaining({ query: "foxes", top_k: 5 }),
      );
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("0.92");
      expect(out).toContain("quick brown fox");
    } finally {
      log.mockRestore();
    }
  });
});
