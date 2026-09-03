import { describe, expect, it } from "vitest";
import {
  CLAUDE_DESKTOP_MODEL_IDS,
  DEFAULT_MODELS,
  PICKER_MODELS,
} from "../src/config/models.js";

describe("model defaults", () => {
  it("uses the current Claude model family", () => {
    expect(DEFAULT_MODELS).toMatchObject({
      opus: "claude-opus-5",
      sonnet: "claude-sonnet-5",
      haiku: "claude-haiku-4-5",
      fable: "claude-fable-5-1",
    });
  });

  it("keeps the shared picker broad while exposing an Anthropic-only Desktop list", () => {
    expect(CLAUDE_DESKTOP_MODEL_IDS).toEqual([
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "claude-fable-5-1",
    ]);

    const sharedIds = PICKER_MODELS.map((model) => model.id);
    expect(sharedIds).toEqual(expect.arrayContaining(CLAUDE_DESKTOP_MODEL_IDS));
    expect(sharedIds).toEqual(expect.arrayContaining([
      "gpt-5.5",
      "gemini-3.1-pro-preview",
      "deepinfra/kimi-k2.6",
    ]));
  });
});
