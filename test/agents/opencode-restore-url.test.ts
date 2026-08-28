import { describe, it, expect } from "vitest";
import { restoreTarget } from "../../src/agents/opencode.js";

describe("restoreTarget", () => {
  it("upgrades the legacy /v2/openai base anyone who followed the old docs still has", () => {
    expect(restoreTarget("https://api.opper.ai/v2/openai")).toBe("https://api.opper.ai/v3/compat");
  });

  it("clears a session URL left behind by a killed run", () => {
    expect(restoreTarget("https://api.opper.ai/v3/session/sess_abc")).toBe(
      "https://api.opper.ai/v3/compat",
    );
  });

  it("leaves the current compat URL untouched", () => {
    expect(restoreTarget("https://api.opper.ai/v3/compat")).toBe("https://api.opper.ai/v3/compat");
  });

  it("preserves a self-hosted gateway, which is a real preference and not rot", () => {
    expect(restoreTarget("https://gateway.internal.acme/v3/compat")).toBe(
      "https://gateway.internal.acme/v3/compat",
    );
  });

  it("defaults when nothing is stored", () => {
    expect(restoreTarget(undefined)).toBe("https://api.opper.ai/v3/compat");
  });
});
