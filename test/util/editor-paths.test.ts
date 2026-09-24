import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import { opencodeConfigPath } from "../../src/util/editor-paths.js";

describe("editor paths", () => {
  let prev: string | undefined;
  let prevXdg: string | undefined;
  beforeEach(() => {
    prev = process.env.OPPER_EDITOR_HOME;
    prevXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.OPPER_EDITOR_HOME;
    delete process.env.XDG_CONFIG_HOME;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.OPPER_EDITOR_HOME;
    else process.env.OPPER_EDITOR_HOME = prev;
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  });

  it("opencode global defaults to ~/.config/opencode/opencode.json", () => {
    expect(opencodeConfigPath("global")).toBe(
      join(homedir(), ".config", "opencode", "opencode.json"),
    );
  });

  it("opencode local defaults to cwd/opencode.json", () => {
    expect(opencodeConfigPath("local")).toBe(
      join(process.cwd(), "opencode.json"),
    );
  });

  it("OPPER_EDITOR_HOME overrides the global home", () => {
    process.env.OPPER_EDITOR_HOME = "/tmp/fake";
    expect(opencodeConfigPath("global")).toBe(
      "/tmp/fake/.config/opencode/opencode.json",
    );
  });

  it("honors XDG_CONFIG_HOME for the real OpenCode global config", () => {
    process.env.XDG_CONFIG_HOME = "/tmp/custom-xdg";
    expect(opencodeConfigPath("global")).toBe("/tmp/custom-xdg/opencode/opencode.json");
    process.env.OPPER_EDITOR_HOME = "/tmp/test-editor-home";
    expect(opencodeConfigPath("global")).toBe("/tmp/test-editor-home/.config/opencode/opencode.json");
  });
});
