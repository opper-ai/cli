import { describe, it, expect } from "vitest";
import { listEditors } from "../../src/setup/editors.js";

describe("listEditors", () => {
  it("includes OpenCode and Continue with configure=true, others with configure=false", () => {
    const editors = listEditors();
    const opencode = editors.find((e) => e.id === "opencode");
    const continueDev = editors.find((e) => e.id === "continue");
    const cursor = editors.find((e) => e.id === "cursor");
    expect(opencode?.configure).toBe(true);
    expect(continueDev?.configure).toBe(true);
    expect(cursor?.configure).toBe(false);
    expect(cursor?.docsUrl).toMatch(/^https:\/\//);
  });
});
