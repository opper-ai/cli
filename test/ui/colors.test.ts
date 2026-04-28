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
    const s = brand.accent("hi");
    expect(s).toMatch(/\x1b\[38;2;245;191;165m/);
    expect(s).toContain("hi");
    expect(s).toMatch(/\x1b\[0m$/);
  });

  it("returns plain text when NO_COLOR is set", () => {
    process.env.NO_COLOR = "1";
    expect(brand.accent("hi")).toBe("hi");
  });
});
