import { describe, it, expect, vi } from "vitest";

const SKILLS_RESULT = { targets: ["claude"], skills: ["opper-cli", "opper-api"] };

const mocks = {
  isSkillsInstalled: vi.fn(),
  installSkills: vi.fn().mockResolvedValue(SKILLS_RESULT),
  updateSkills: vi.fn().mockResolvedValue(SKILLS_RESULT),
  uninstallSkills: vi.fn().mockResolvedValue(SKILLS_RESULT),
  bundledSkills: vi.fn().mockReturnValue(["opper-cli", "opper-api"]),
  installedTargets: vi.fn().mockReturnValue([
    {
      target: "claude",
      dir: "/tmp/.claude/skills",
      installed: ["opper-cli", "opper-api"],
    },
  ]),
};

vi.mock("../../src/setup/skills.js", () => mocks);

const {
  skillsInstallCommand,
  skillsUpdateCommand,
  skillsUninstallCommand,
  skillsListCommand,
} = await import("../../src/commands/skills.js");

describe("skills commands", () => {
  it("install calls installSkills when not already present", async () => {
    mocks.isSkillsInstalled.mockReturnValue(false);
    mocks.installSkills.mockClear();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await skillsInstallCommand();
      expect(mocks.installSkills).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("install short-circuits with a hint when already installed and no names given", async () => {
    mocks.isSkillsInstalled.mockReturnValue(true);
    mocks.installSkills.mockClear();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await skillsInstallCommand();
      expect(mocks.installSkills).not.toHaveBeenCalled();
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toMatch(/already/i);
    } finally {
      log.mockRestore();
    }
  });

  it("install with explicit names runs even when some skills are installed", async () => {
    mocks.isSkillsInstalled.mockReturnValue(true);
    mocks.installSkills.mockClear();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await skillsInstallCommand(["opper-cli"]);
      expect(mocks.installSkills).toHaveBeenCalledWith(["opper-cli"]);
    } finally {
      log.mockRestore();
    }
  });

  it("update forwards skill names through to updateSkills", async () => {
    mocks.updateSkills.mockClear();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await skillsUpdateCommand(["opper-cli"]);
      expect(mocks.updateSkills).toHaveBeenCalledWith(["opper-cli"]);
    } finally {
      log.mockRestore();
    }
  });

  it("uninstall forwards names and short-circuits when nothing is installed", async () => {
    mocks.isSkillsInstalled.mockReturnValue(false);
    mocks.uninstallSkills.mockClear();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await skillsUninstallCommand(["opper-cli"]);
      expect(mocks.uninstallSkills).not.toHaveBeenCalled();
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toMatch(/not installed|nothing to do/i);
    } finally {
      log.mockRestore();
    }
  });

  it("list renders the per-skill matrix", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await skillsListCommand();
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toMatch(/SKILL\s+CLAUDE/);
      expect(out).toContain("opper-cli");
      expect(out.toLowerCase()).toContain("installed");
    } finally {
      log.mockRestore();
    }
  });
});
