import { describe, it, expect } from "vitest";
import type {
  AgentAdapter,
  DetectResult,
  OpperRouting,
  SnapshotHandle,
} from "../../src/agents/types.js";

describe("AgentAdapter interface", () => {
  it("allows a stub implementation to satisfy all required fields", () => {
    const stub: AgentAdapter = {
      name: "stub",
      displayName: "Stub",
      binary: "stub",
      docsUrl: "https://example.com",
      async detect(): Promise<DetectResult> {
        return { installed: false };
      },
      async install(): Promise<void> {
        return;
      },
      async snapshotConfig(): Promise<SnapshotHandle> {
        return {
          agent: "stub",
          backupPath: "/tmp/stub.bak",
          timestamp: "2026-04-21T00:00:00.000Z",
        };
      },
      async writeOpperConfig(_c: OpperRouting): Promise<void> {
        return;
      },
      async restoreConfig(_h: SnapshotHandle): Promise<void> {
        return;
      },
      async spawn(_args: string[]): Promise<number> {
        return 0;
      },
    };
    expect(stub.name).toBe("stub");
  });
});
