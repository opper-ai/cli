import { describe, expect, it } from "vitest";
import { applyDesktopConfig, removeDesktopConfig, readDesktopConfig } from "../../src/setup/codex-desktop-config.js";

const settings = {
  model: "claude-sonnet-5",
  model_catalog_json: "/tmp/Opper Models/catalog.json",
  provider: { name: "Opper", base_url: "https://api.opper.ai/v3/compat", wire_api: "responses", auth: { command: "/node", args: ["/helper.mjs", "prod"] } },
};
const original = '# user preferences\nmodel = "gpt-5.5" # chosen model\nmodel_provider = "openai"\n\n[projects."/my/project"]\ntrust_level = "trusted"\n\n[mcp_servers.notes]\ncommand = "notes"\n';

describe("Codex desktop configuration", () => {
  it("preserves comments, project and MCP settings and restores the exact original", () => {
    const applied = applyDesktopConfig(original, settings);
    expect(applied.text).toContain('# user preferences\nmodel = "claude-sonnet-5" # chosen model');
    expect(applied.text).toContain('[projects."/my/project"]\ntrust_level = "trusted"');
    expect(readDesktopConfig(applied.text).model_provider).toBe("opper-desktop");
    expect(removeDesktopConfig(applied.text, applied.state)).toBe(original);
  });
  it("preserves unrelated edits and deliberate model changes made while enabled", () => {
    const applied = applyDesktopConfig(original, settings);
    const edited = applied.text.replace('model = "claude-sonnet-5"', 'model = "user-choice"') + '\n[desktop]\ntheme = "dark"\n';
    const removed = removeDesktopConfig(edited, applied.state);
    expect(removed).toContain('model = "user-choice"');
    expect(removed).toContain('[desktop]\ntheme = "dark"');
    expect(readDesktopConfig(removed).model_provider).toBe("openai");
    expect(removed).not.toContain("opper-desktop");
  });
  it("reconfiguration remembers the original settings and uses the new model", () => {
    const first = applyDesktopConfig(original, settings);
    const second = applyDesktopConfig(first.text, { ...settings, model: "claude-opus-5" }, first.state);
    expect(readDesktopConfig(second.text).model).toBe("claude-opus-5");
    expect(removeDesktopConfig(second.text, second.state)).toBe(original);
  });
  it("does not confuse multiline strings or nested model keys with root defaults", () => {
    const text = 'instructions = """\nmodel = "inside instructions"\n"""\n[profiles.other]\nmodel = "profile-model"\n';
    const applied = applyDesktopConfig(text, settings);
    expect(applied.text).toContain(text);
    expect(removeDesktopConfig(applied.text, applied.state)).toBe(text);
  });
  it("refuses malformed config and an existing unowned provider", () => {
    expect(() => applyDesktopConfig('model = "broken', settings)).toThrow();
    expect(() => applyDesktopConfig('[model_providers.opper-desktop]\nname = "Mine"\n', settings)).toThrow(/already exists/);
  });
  it("does not delete a provider changed independently after setup", () => {
    const applied = applyDesktopConfig(original, settings);
    const edited = applied.text.replace('name = "Opper"', 'name = "Edited provider"');
    expect(() => removeDesktopConfig(edited, applied.state)).toThrow(/changed/);
  });
  it("restores originally absent fields while retaining new settings", () => {
    const applied = applyDesktopConfig("# empty defaults\n", settings);
    const removed = removeDesktopConfig(applied.text + '\n[desktop]\nnotifications = false\n', applied.state);
    const cfg = readDesktopConfig(removed);
    expect(cfg.model).toBeUndefined();
    expect(cfg.model_provider).toBeUndefined();
    expect(cfg.model_catalog_json).toBeUndefined();
    expect(cfg.web_search).toBeUndefined();
    expect(removed).toContain("# empty defaults");
    expect(removed).toContain("notifications = false");
  });
  it("disables cached-only web search for cross-provider compatibility and restores its prior setting", () => {
    const text = 'web_search = "cached" # original preference\n';
    const applied = applyDesktopConfig(text, settings);
    expect(readDesktopConfig(applied.text).web_search).toBe("disabled");
    expect(removeDesktopConfig(applied.text, applied.state)).toBe(text);
    const edited = applied.text + '\n[desktop]\ntheme="dark"\n';
    expect(removeDesktopConfig(edited, applied.state)).toContain('web_search = "cached" # original preference');
  });
});
