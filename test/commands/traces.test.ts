import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const getMock = vi.fn();
const delMock = vi.fn();
vi.mock("../../src/api/client.js", () => ({
  OpperApi: vi.fn().mockImplementation(() => ({ get: getMock, del: delMock })),
}));

const {
  tracesListCommand,
  tracesGetCommand,
  tracesDeleteCommand,
} = await import("../../src/commands/traces.js");

useTempOpperHome();

describe("traces commands", () => {
  beforeEach(() => {
    getMock.mockReset();
    delMock.mockReset();
  });

  it("list calls GET /v3/traces and prints a table", async () => {
    await setSlot("default", { apiKey: "k" });
    // Mirrors what /v3/traces returns in production: a `data` envelope, `id`
    // rather than `uuid`, and `status` present only on a failed trace.
    getMock.mockResolvedValue({
      data: [
        { id: "t1", name: "call-foo", start_time: "2026-04-21T00:00:00Z", duration_ms: 42, span_count: 1 },
        { id: "t2", name: "call-bar", status: "failed", start_time: "2026-04-21T00:01:00Z", duration_ms: 1200, span_count: 3 },
      ],
      meta: { total_count: 2 },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await tracesListCommand({ key: "default" });
      expect(getMock).toHaveBeenCalledWith("/v3/traces", expect.any(Object));
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("t1");
      expect(out).toContain("call-bar");
    } finally {
      log.mockRestore();
    }
  });

  it("list forwards --limit and --name", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({ data: [], meta: { total_count: 0 } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await tracesListCommand({ key: "default", limit: 50, name: "foo" });
      expect(getMock).toHaveBeenCalledWith(
        "/v3/traces",
        expect.objectContaining({ limit: 50, name: "foo" }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it("get prints trace details", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({
      data: {
        id: "t1",
        name: "call",
        status: "failed",
        start_time: "2026-04-21T00:00:00Z",
        duration_ms: 42,
        span_count: 1,
        spans: [{ id: "s1", name: "root" }],
      },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await tracesGetCommand({ id: "t1", key: "default" });
      expect(getMock).toHaveBeenCalledWith("/v3/traces/t1");
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("t1");
      expect(out).toContain("failed");
      expect(out).toContain("spans:");
    } finally {
      log.mockRestore();
    }
  });

  it("delete calls DELETE /v3/traces/{id}", async () => {
    await setSlot("default", { apiKey: "k" });
    delMock.mockResolvedValue(undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await tracesDeleteCommand({ id: "t1", key: "default" });
      expect(delMock).toHaveBeenCalledWith("/v3/traces/t1");
    } finally {
      log.mockRestore();
    }
  });
});
