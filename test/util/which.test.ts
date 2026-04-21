import { describe, it, expect } from "vitest";
import { which } from "../../src/util/which.js";

describe("which", () => {
  it("returns a path for a binary that exists (node)", async () => {
    const path = await which("node");
    expect(path).not.toBeNull();
    expect(path).toMatch(/node$/);
  });

  it("returns null for a nonexistent binary", async () => {
    const path = await which("this-binary-definitely-does-not-exist-xyz123");
    expect(path).toBeNull();
  });
});
