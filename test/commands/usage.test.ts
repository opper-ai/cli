import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const getMock = vi.fn();
vi.mock("../../src/api/client.js", () => ({
  OpperApi: vi.fn().mockImplementation(() => ({ get: getMock })),
}));

const { usageListCommand } = await import("../../src/commands/usage.js");

useTempOpperHome();

describe("usageListCommand", () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it("forwards query params to /v2/analytics/usage", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue([
      {
        time_bucket: "2026-04-21T00:00:00Z",
        cost: 0.001234,
        count: 3,
        total_tokens: 450,
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await usageListCommand({
        key: "default",
        fromDate: "2026-04-20",
        toDate: "2026-04-21",
        granularity: "day",
        fields: ["total_tokens"],
        groupBy: ["model"],
      });
      expect(getMock).toHaveBeenCalledWith(
        "/v2/analytics/usage",
        expect.objectContaining({
          from_date: "2026-04-20",
          to_date: "2026-04-21",
          granularity: "day",
          fields: "total_tokens",
          group_by: "model",
        }),
      );
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("2026-04-21");
      expect(out).toContain("450");
    } finally {
      log.mockRestore();
    }
  });

  it("prints CSV when out=csv", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue([
      { time_bucket: "2026-04-21T00:00:00Z", cost: 0.001, count: 2, total_tokens: 100 },
      { time_bucket: "2026-04-22T00:00:00Z", cost: 0.002, count: 5, total_tokens: 200 },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await usageListCommand({ key: "default", out: "csv", fields: ["total_tokens"] });
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out.split("\n")[0]).toMatch(/time_bucket,cost,count,total_tokens/);
      expect(out).toContain("2026-04-21T00:00:00Z,0.001,2,100");
    } finally {
      log.mockRestore();
    }
  });
});
