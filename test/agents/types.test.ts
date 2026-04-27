import { describe, it, expect } from "vitest";
import {
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
});
