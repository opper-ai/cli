import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { brand } from "../../src/ui/colors.js";

describe("brand colors", () => {
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prev;
  });

  it("wraps text in ANSI escape codes by default", () => {
    const s = brand.purple("hi");
    expect(s).toMatch(/\x1b\[38;2;60;60;175m/);
    expect(s).toContain("hi");
    expect(s).toMatch(/\x1b\[0m$/);
  });

  it("returns plain text when NO_COLOR is set", () => {
    process.env.NO_COLOR = "1";
    expect(brand.purple("hi")).toBe("hi");
  });
});
