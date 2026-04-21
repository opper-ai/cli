import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  opencodeConfigPath,
  continueConfigPath,
} from "../../src/util/editor-paths.js";

describe("editor paths", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.OPPER_EDITOR_HOME;
    delete process.env.OPPER_EDITOR_HOME;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.OPPER_EDITOR_HOME;
    else process.env.OPPER_EDITOR_HOME = prev;
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

  it("continue global defaults to ~/.continue/config.yaml", () => {
    expect(continueConfigPath("global")).toBe(
      join(homedir(), ".continue", "config.yaml"),
    );
  });

  it("continue local defaults to cwd/.continue/config.yaml", () => {
    expect(continueConfigPath("local")).toBe(
      join(process.cwd(), ".continue", "config.yaml"),
    );
  });

  it("OPPER_EDITOR_HOME overrides the global home for both editors", () => {
    process.env.OPPER_EDITOR_HOME = "/tmp/fake";
    expect(opencodeConfigPath("global")).toBe(
      "/tmp/fake/.config/opencode/opencode.json",
    );
    expect(continueConfigPath("global")).toBe(
      "/tmp/fake/.continue/config.yaml",
    );
  });
});
