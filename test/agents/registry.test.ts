import { describe, it, expect } from "vitest";
import { getAdapter, listAdapters } from "../../src/agents/registry.js";
import { hermes } from "../../src/agents/hermes.js";

describe("adapter registry", () => {
  it("lists all registered adapters", () => {
    const list = listAdapters();
    expect(list.map((a) => a.name)).toContain("hermes");
  });

  it("looks up hermes by name", () => {
    expect(getAdapter("hermes")).toBe(hermes);
  });

  it("returns null for unknown names", () => {
    expect(getAdapter("nonexistent")).toBeNull();
  });

  it("registers claude-desktop as a launchable adapter", async () => {
    const adapter = getAdapter("claude-desktop");
    expect(adapter).not.toBeNull();
    expect(adapter?.displayName).toBe("Claude Desktop");
    expect(typeof adapter?.spawn).toBe("function");
  });

  it("registers Conductor as a configure-only Codex integration", () => {
    const adapter = getAdapter("conductor");
    expect(adapter?.displayName).toBe("Conductor (Codex)");
    expect(adapter?.spawn).toBeUndefined();
    expect(typeof adapter?.configure).toBe("function");
    expect(typeof adapter?.unconfigure).toBe("function");
  });
});
