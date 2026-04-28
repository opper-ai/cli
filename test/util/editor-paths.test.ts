import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import { opencodeConfigPath } from "../../src/util/editor-paths.js";

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

  it("OPPER_EDITOR_HOME overrides the global home", () => {
    process.env.OPPER_EDITOR_HOME = "/tmp/fake";
    expect(opencodeConfigPath("global")).toBe(
      "/tmp/fake/.config/opencode/opencode.json",
    );
  });
});
