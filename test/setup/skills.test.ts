import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSkillsInstalled,
  installSkills,
  updateSkills,
  listInstalledSkills,
  installedTargets,
  uninstallSkills,
} from "../../src/setup/skills.js";

describe("skills (Claude target only)", () => {
  let claudeHome: string;
  let isolatedCodex: string;
  let prevSkills: string | undefined;
  let prevCodex: string | undefined;

  beforeEach(() => {
    prevSkills = process.env.OPPER_SKILLS_HOME;
    prevCodex = process.env.CODEX_HOME;

    claudeHome = mkdtempSync(join(tmpdir(), "opper-skills-claude-"));
    process.env.OPPER_SKILLS_HOME = claudeHome;

    // Point CODEX_HOME at a path that doesn't exist so the Codex target
    // is not "live" — these tests are about the Claude path only.
    isolatedCodex = join(tmpdir(), `opper-skills-no-codex-${process.pid}-${Date.now()}`);
    process.env.CODEX_HOME = isolatedCodex;
  });

  afterEach(() => {
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(isolatedCodex, { recursive: true, force: true });
    if (prevSkills === undefined) delete process.env.OPPER_SKILLS_HOME;
    else process.env.OPPER_SKILLS_HOME = prevSkills;
    if (prevCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodex;
  });

  it("isSkillsInstalled returns false on a clean system", () => {
    expect(isSkillsInstalled()).toBe(false);
  });

  it("installSkills copies bundled skills into the install dir", async () => {
    await installSkills();
    expect(existsSync(join(claudeHome, "opper-cli", "SKILL.md"))).toBe(true);
    expect(existsSync(join(claudeHome, "opper-api", "SKILL.md"))).toBe(true);
    expect(existsSync(join(claudeHome, "opper-node-sdk", "SKILL.md"))).toBe(true);
    expect(existsSync(join(claudeHome, "opper-node-agents", "SKILL.md"))).toBe(true);
    expect(existsSync(join(claudeHome, "opper-python-sdk", "SKILL.md"))).toBe(true);
    expect(existsSync(join(claudeHome, "opper-python-agents", "SKILL.md"))).toBe(true);
  });

  it("installSkills returns the targets it installed to", async () => {
    const result = await installSkills();
    expect(result.targets).toEqual(["claude"]);
    expect(result.skills.length).toBeGreaterThanOrEqual(6);
  });

  it("installSkills accepts a subset of skill names", async () => {
    const result = await installSkills(["opper-cli", "opper-api"]);
    expect(result.skills.sort()).toEqual(["opper-api", "opper-cli"]);
    expect(existsSync(join(claudeHome, "opper-cli", "SKILL.md"))).toBe(true);
    expect(existsSync(join(claudeHome, "opper-api", "SKILL.md"))).toBe(true);
    // The non-selected skills are not installed.
    expect(existsSync(join(claudeHome, "opper-node-sdk"))).toBe(false);
  });

  it("installSkills rejects unknown skill names", async () => {
    await expect(installSkills(["nonsense"])).rejects.toMatchObject({
      code: "API_ERROR",
    });
  });

  it("isSkillsInstalled returns true after install", async () => {
    await installSkills();
    expect(isSkillsInstalled()).toBe(true);
  });

  it("isSkillsInstalled ignores unrelated dirs", () => {
    mkdirSync(join(claudeHome, "some-other-skill"), { recursive: true });
    writeFileSync(join(claudeHome, "some-other-skill", "SKILL.md"), "# foo");
    expect(isSkillsInstalled()).toBe(false);
  });

  it("updateSkills overwrites stale content", async () => {
    mkdirSync(join(claudeHome, "opper-cli"), { recursive: true });
    writeFileSync(join(claudeHome, "opper-cli", "SKILL.md"), "STALE CONTENT");
    await updateSkills();
    const after = readFileSync(join(claudeHome, "opper-cli", "SKILL.md"), "utf8");
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

describe("skills (Codex target)", () => {
  let claudeHome: string;
  let codexHome: string;
  let prevSkills: string | undefined;
  let prevCodex: string | undefined;

  beforeEach(() => {
    prevSkills = process.env.OPPER_SKILLS_HOME;
    prevCodex = process.env.CODEX_HOME;

    claudeHome = mkdtempSync(join(tmpdir(), "opper-skills-claude-"));
    codexHome = mkdtempSync(join(tmpdir(), "opper-skills-codex-"));
    process.env.OPPER_SKILLS_HOME = claudeHome;
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    if (prevSkills === undefined) delete process.env.OPPER_SKILLS_HOME;
    else process.env.OPPER_SKILLS_HOME = prevSkills;
    if (prevCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodex;
  });

  it("installs to both claude and codex when codex home exists", async () => {
    const result = await installSkills();
    expect(result.targets.sort()).toEqual(["claude", "codex"]);

    expect(existsSync(join(claudeHome, "opper-cli", "SKILL.md"))).toBe(true);
    expect(existsSync(join(codexHome, "skills", "opper-cli", "SKILL.md"))).toBe(true);
  });

  it("registers each skill in codex config.toml inside a managed sentinel block", async () => {
    await installSkills();
    const cfg = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(cfg).toContain("# >>> opper-cli-skills >>>");
    expect(cfg).toContain("# <<< opper-cli-skills <<<");
    expect(cfg).toContain("[[skills.config]]");
    expect(cfg).toContain(join(codexHome, "skills", "opper-cli", "SKILL.md"));
    expect(cfg).toContain("enabled = true");
  });

  it("preserves user-authored config.toml content outside the sentinel", async () => {
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        "[[skills.config]]",
        'path = "/Users/me/.codex/skills/my-thing/SKILL.md"',
        "enabled = true",
        "",
      ].join("\n"),
      "utf8",
    );
    await installSkills();
    const cfg = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(cfg).toContain("/Users/me/.codex/skills/my-thing/SKILL.md");
    expect(cfg).toContain("# >>> opper-cli-skills >>>");
  });

  it("uninstallSkills removes files and clears the codex sentinel", async () => {
    await installSkills();
    await uninstallSkills();
    expect(existsSync(join(claudeHome, "opper-cli"))).toBe(false);
    expect(existsSync(join(codexHome, "skills", "opper-cli"))).toBe(false);
    const cfg = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(cfg).not.toContain("# >>> opper-cli-skills >>>");
  });

  it("installedTargets reports per-skill state across each target", async () => {
    const before = installedTargets();
    expect(before.map((t) => t.target).sort()).toEqual(["claude", "codex"]);
    expect(before.every((t) => t.installed.length === 0)).toBe(true);

    await installSkills();
    const after = installedTargets();
    for (const status of after) {
      expect(status.installed).toContain("opper-cli");
      expect(status.installed.length).toBeGreaterThanOrEqual(6);
    }
  });

  it("uninstallSkills removes only the named subset and re-syncs the codex registry", async () => {
    await installSkills();
    await uninstallSkills(["opper-api"]);

    expect(existsSync(join(codexHome, "skills", "opper-api"))).toBe(false);
    expect(existsSync(join(codexHome, "skills", "opper-cli"))).toBe(true);

    const cfg = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(cfg).not.toContain("opper-api/SKILL.md");
    expect(cfg).toContain("opper-cli/SKILL.md");
  });
});
