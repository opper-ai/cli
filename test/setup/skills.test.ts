import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSkillsInstalled,
  installSkills,
  updateSkills,
  listInstalledSkills,
} from "../../src/setup/skills.js";

describe("skills", () => {
  let home: string;
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.OPPER_SKILLS_HOME;
    home = mkdtempSync(join(tmpdir(), "opper-skills-"));
    process.env.OPPER_SKILLS_HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (prev === undefined) delete process.env.OPPER_SKILLS_HOME;
    else process.env.OPPER_SKILLS_HOME = prev;
  });

  it("isSkillsInstalled returns false on a clean system", () => {
    expect(isSkillsInstalled()).toBe(false);
  });

  it("installSkills copies bundled skills into the install dir", async () => {
    await installSkills();
    // All six skills are present.
    expect(existsSync(join(home, "opper-cli", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, "opper-api", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, "opper-node-sdk", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, "opper-node-agents", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, "opper-python-sdk", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, "opper-python-agents", "SKILL.md"))).toBe(true);
  });

  it("isSkillsInstalled returns true after install", async () => {
    await installSkills();
    expect(isSkillsInstalled()).toBe(true);
  });

  it("isSkillsInstalled ignores unrelated dirs", () => {
    mkdirSync(join(home, "some-other-skill"), { recursive: true });
    writeFileSync(join(home, "some-other-skill", "SKILL.md"), "# foo");
    expect(isSkillsInstalled()).toBe(false);
  });

  it("updateSkills overwrites stale content", async () => {
    mkdirSync(join(home, "opper-cli"), { recursive: true });
    writeFileSync(join(home, "opper-cli", "SKILL.md"), "STALE CONTENT");
    await updateSkills();
    const after = readFileSync(join(home, "opper-cli", "SKILL.md"), "utf8");
    expect(after).not.toBe("STALE CONTENT");
    expect(after).toContain("opper-cli");
  });

  it("listInstalledSkills returns the installed skill names", async () => {
    expect(await listInstalledSkills()).toEqual([]);
    await installSkills();
    const installed = (await listInstalledSkills()).sort();
    expect(installed).toContain("opper-cli");
    expect(installed).toContain("opper-api");
    expect(installed.length).toBeGreaterThanOrEqual(6);
  });
});
