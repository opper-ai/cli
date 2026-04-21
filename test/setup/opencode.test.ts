import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureOpenCode } from "../../src/setup/opencode.js";
import { opencodeConfigPath } from "../../src/util/editor-paths.js";

describe("configureOpenCode", () => {
  let home: string;
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.OPPER_EDITOR_HOME;
    home = mkdtempSync(join(tmpdir(), "opper-opencode-"));
    process.env.OPPER_EDITOR_HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (prev === undefined) delete process.env.OPPER_EDITOR_HOME;
    else process.env.OPPER_EDITOR_HOME = prev;
  });

  it("writes the template to the global location and creates the directory", async () => {
    const result = await configureOpenCode({ location: "global" });
    const expected = opencodeConfigPath("global");
    expect(result.path).toBe(expected);
    expect(result.wrote).toBe(true);
    expect(existsSync(expected)).toBe(true);
    const parsed = JSON.parse(readFileSync(expected, "utf8"));
    expect(parsed.provider).toBeDefined();
  });

  it("refuses to overwrite an existing Opper provider unless overwrite=true", async () => {
    const target = opencodeConfigPath("global");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      target,
      JSON.stringify({ provider: { opper: { existing: true } } }),
      "utf8",
    );

    const without = await configureOpenCode({ location: "global" });
    expect(without.wrote).toBe(false);
    expect(without.reason).toBe("exists");

    const withOverride = await configureOpenCode({
      location: "global",
      overwrite: true,
    });
    expect(withOverride.wrote).toBe(true);
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    expect(parsed.provider.opper.existing).toBeUndefined();
  });

  it("writes the template when existing config is unparseable", async () => {
    const target = opencodeConfigPath("global");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(target, "{not json", "utf8");
    const result = await configureOpenCode({ location: "global" });
    expect(result.wrote).toBe(true);
  });
});
