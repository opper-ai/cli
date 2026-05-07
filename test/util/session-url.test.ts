import { describe, it, expect } from "vitest";
import {
  newSessionId,
  buildSessionBaseUrl,
  validateTags,
} from "../../src/util/session-url.js";

describe("session-url", () => {
  it("newSessionId returns sess_<uuid v4>", () => {
    const id = newSessionId();
    expect(id).toMatch(
      /^sess_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("buildSessionBaseUrl returns host/v3/session/<sid> with no tags", () => {
    const url = buildSessionBaseUrl("https://api.opper.ai", "sess_abc", {});
    expect(url).toBe("https://api.opper.ai/v3/session/sess_abc");
  });

  it("buildSessionBaseUrl appends tag pairs in stable order", () => {
    const url = buildSessionBaseUrl("https://api.opper.ai", "sess_abc", {
      customer: "acme",
      team: "eu",
    });
    expect(url).toBe(
      "https://api.opper.ai/v3/session/sess_abc/customer:acme/team:eu",
    );
  });

  it("buildSessionBaseUrl strips trailing slashes from the host", () => {
    const url = buildSessionBaseUrl(
      "https://api.opper.ai/",
      "sess_abc",
      {},
    );
    expect(url).toBe("https://api.opper.ai/v3/session/sess_abc");
  });

  it("buildSessionBaseUrl percent-encodes values", () => {
    const url = buildSessionBaseUrl("https://api.opper.ai", "sess_abc", {
      team: "eu/west",
    });
    expect(url).toBe(
      "https://api.opper.ai/v3/session/sess_abc/team:eu%2Fwest",
    );
  });

  it("validateTags rejects an invalid key", () => {
    expect(() => validateTags({ "1bad": "v" })).toThrow(/invalid tag key/);
  });

  it("validateTags rejects opper.* keys", () => {
    expect(() => validateTags({ "opper.cost": "1" })).toThrow(/reserved/);
  });

  it("validateTags rejects Opper.* keys (case-insensitive)", () => {
    expect(() => validateTags({ "Opper.cost": "1" })).toThrow(/reserved/);
  });

  it("validateTags rejects oversized values", () => {
    const big = "x".repeat(257);
    expect(() => validateTags({ k: big })).toThrow(/value too long/);
  });

  it("validateTags rejects > 8 pairs", () => {
    const tags: Record<string, string> = {};
    for (let i = 0; i < 9; i++) tags[`k${i}`] = "v";
    expect(() => validateTags(tags)).toThrow(/too many tags/);
  });
});
