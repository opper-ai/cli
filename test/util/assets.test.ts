import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { assetPath } from "../../src/util/assets.js";

describe("assetPath", () => {
  it("resolves the opencode template", () => {
    const path = assetPath("opencode.json");
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as { provider?: Record<string, unknown> };
    expect(parsed.provider).toBeDefined();
  });

  it("returns a path for an arbitrary asset name", () => {
    const path = assetPath("anything.json");
    expect(path).toMatch(/anything\.json$/);
  });
});
