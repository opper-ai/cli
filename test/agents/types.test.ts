import { describe, it, expect } from "vitest";
import {
  adapterSupportsModel,
  filterModelsForAdapter,
  isLaunchable,
  type AgentAdapter,
  type DetectResult,
  type OpperRouting,
} from "../../src/agents/types.js";

describe("AgentAdapter interface", () => {
  it("a minimal adapter satisfies the required surface", () => {
    const stub: AgentAdapter = {
      name: "stub",
      displayName: "Stub",
      docsUrl: "https://example.com",
      async detect(): Promise<DetectResult> {
        return { installed: false };
      },
      async isConfigured(): Promise<boolean> {
        return false;
      },
      async configure(): Promise<void> {
        return;
      },
      async unconfigure(): Promise<void> {
        return;
      },
    };
    expect(stub.name).toBe("stub");
    expect(isLaunchable(stub)).toBe(false);
  });

  it("an adapter with spawn is recognised as launchable", () => {
    const launchable: AgentAdapter = {
      name: "launch",
      displayName: "Launchable",
      docsUrl: "https://example.com",
      async detect(): Promise<DetectResult> {
        return { installed: true };
      },
      async isConfigured(): Promise<boolean> {
        return true;
      },
      async configure(): Promise<void> {
        return;
      },
      async unconfigure(): Promise<void> {
        return;
      },
      async spawn(_args: string[], _routing: OpperRouting): Promise<number> {
        return 0;
      },
    };
    expect(isLaunchable(launchable)).toBe(true);
    if (isLaunchable(launchable)) {
      expect(typeof launchable.spawn).toBe("function");
    }
  });

  it("filters and validates models only when an adapter declares a restriction", () => {
    const restricted: AgentAdapter = {
      name: "restricted",
      displayName: "Restricted",
      docsUrl: "https://example.com",
      supportsModel: (modelId) => /^(?!dynamic\/)(?:[^/]+\/)*claude-/.test(modelId),
      async detect() { return { installed: true }; },
      async isConfigured() { return true; },
      async configure() { return; },
      async unconfigure() { return; },
    };
    const models = [
      { id: "claude-opus-5" },
      { id: "gpt-5.5" },
      { id: "claude-sonnet-5" },
    ];

    expect(adapterSupportsModel(restricted, "claude-opus-5")).toBe(true);
    expect(adapterSupportsModel(restricted, "anthropic/claude-sonnet-5")).toBe(true);
    expect(adapterSupportsModel(restricted, "vertexai/claude-sonnet-5")).toBe(true);
    expect(adapterSupportsModel(restricted, "dynamic/claude-sonnet-5")).toBe(false);
    expect(adapterSupportsModel(restricted, "gpt-5.5")).toBe(false);
    expect(filterModelsForAdapter(restricted, models)).toEqual([
      { id: "claude-opus-5" },
      { id: "claude-sonnet-5" },
    ]);
    const { supportsModel: _supportsModel, ...unrestricted } = restricted;
    expect(adapterSupportsModel(unrestricted, "gpt-5.5")).toBe(true);
  });
});
