import { describe, it, expect, vi } from "vitest";
import { OpperError } from "../../src/errors.js";
import { printError } from "../../src/ui/print.js";

describe("printError", () => {
  it("prints OpperError code, message, and hint to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      printError(
        new OpperError("AUTH_REQUIRED", "Not logged in", "Run opper login."),
      );
      const calls = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(calls).toContain("AUTH_REQUIRED");
      expect(calls).toContain("Not logged in");
      expect(calls).toContain("Run opper login.");
    } finally {
      spy.mockRestore();
    }
  });

  it("prints generic Error with just the message", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      printError(new Error("boom"));
      const calls = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(calls).toContain("boom");
      expect(calls).not.toContain("undefined");
    } finally {
      spy.mockRestore();
    }
  });
});
