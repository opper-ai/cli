import { afterEach, describe, it, expect, beforeEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  opperHome,
  configPath,
  backupsDir,
  legacyConfigPath,
} from "../../src/auth/paths.js";

describe("paths", () => {
  let origHome: string | undefined;

  beforeEach(() => {
    origHome = process.env.OPPER_HOME;
    delete process.env.OPPER_HOME;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.OPPER_HOME;
    else process.env.OPPER_HOME = origHome;
  });

  it("defaults opperHome() to ~/.opper", () => {
    expect(opperHome()).toBe(join(homedir(), ".opper"));
  });

  it("honours OPPER_HOME env override", () => {
    process.env.OPPER_HOME = "/tmp/fakehome";
    expect(opperHome()).toBe("/tmp/fakehome");
  });

  it("configPath() is opperHome()/config.json", () => {
    process.env.OPPER_HOME = "/tmp/fakehome";
    expect(configPath()).toBe("/tmp/fakehome/config.json");
  });

  it("backupsDir() is opperHome()/backups", () => {
    process.env.OPPER_HOME = "/tmp/fakehome";
    expect(backupsDir()).toBe("/tmp/fakehome/backups");
  });

  it("legacyConfigPath() is ~/.oppercli", () => {
    expect(legacyConfigPath()).toBe(join(homedir(), ".oppercli"));
  });
});
