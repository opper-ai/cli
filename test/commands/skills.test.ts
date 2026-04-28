import { describe, it, expect, vi } from "vitest";

const mocks = {
  isSkillsInstalled: vi.fn(),
  installSkills: vi.fn().mockResolvedValue(["claude"]),
  updateSkills: vi.fn().mockResolvedValue(["claude"]),
  uninstallSkills: vi.fn().mockResolvedValue(["claude"]),
  installedTargets: vi.fn().mockReturnValue([
    { target: "claude", dir: "/tmp/.claude/skills", installed: true },
  ]),
};

vi.mock("../../src/setup/skills.js", () => mocks);

const { skillsInstallCommand, skillsUpdateCommand, skillsListCommand } =
  await import("../../src/commands/skills.js");

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

  it("install short-circuits with a hint when already installed", async () => {
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

  it("update calls updateSkills", async () => {
    mocks.updateSkills.mockClear();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await skillsUpdateCommand();
      expect(mocks.updateSkills).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("list prints whether Opper skills are installed", async () => {
    mocks.isSkillsInstalled.mockReturnValue(true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await skillsListCommand();
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toMatch(/installed/i);
    } finally {
      log.mockRestore();
    }
  });
});
