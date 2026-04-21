import { describe, it, expect } from "vitest";
import { OPPER_OPENAI_COMPAT_URL } from "../../src/api/compat.js";

describe("OPPER_OPENAI_COMPAT_URL", () => {
  it("is an https URL on api.opper.ai", () => {
    expect(OPPER_OPENAI_COMPAT_URL).toMatch(/^https:\/\/api\.opper\.ai\//);
  });
});
