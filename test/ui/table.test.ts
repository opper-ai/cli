import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { printTable } from "../../src/ui/table.js";

describe("printTable", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prev;
  });

  it("prints header + rows aligned to the widest column", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      printTable(
        ["NAME", "SCORE"],
        [
          ["alpha", "12"],
          ["beta", "3"],
        ],
      );
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines[0]).toMatch(/NAME\s+SCORE/);
      expect(lines[1]).toMatch(/alpha\s+12/);
      expect(lines[2]).toMatch(/beta\s+3/);
    } finally {
      log.mockRestore();
    }
  });

  it("prints '(no results)' when rows is empty", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      printTable(["A"], []);
      expect(log).toHaveBeenCalledWith("(no results)");
    } finally {
      log.mockRestore();
    }
  });
});
