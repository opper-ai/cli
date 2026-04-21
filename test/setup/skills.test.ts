import { describe, it, expect, vi } from "vitest";

const runMock = vi.fn();
vi.mock("../../src/util/run.js", () => ({ run: runMock }));

const { isSkillsInstalled, installSkills, updateSkills } = await import(
  "../../src/setup/skills.js"
);

describe("skills", () => {
  it("isSkillsInstalled returns true when `npx skills list` mentions opper", () => {
    runMock.mockReturnValue({
      code: 0,
      stdout: "• opper-ai/opper-skills\n• other",
      stderr: "",
    });
    expect(isSkillsInstalled()).toBe(true);
    expect(runMock).toHaveBeenCalledWith("npx", ["skills", "list"]);
  });

  it("isSkillsInstalled returns false when no match", () => {
    runMock.mockReturnValue({ code: 0, stdout: "• foo\n• bar", stderr: "" });
    expect(isSkillsInstalled()).toBe(false);
  });

  it("isSkillsInstalled returns false when `npx skills` exits non-zero", () => {
    runMock.mockReturnValue({ code: 1, stdout: "", stderr: "no such command" });
    expect(isSkillsInstalled()).toBe(false);
  });

  it("installSkills runs `npx skills add opper-ai/opper-skills` with inherited stdio", async () => {
    runMock.mockClear();
    runMock.mockReturnValue({ code: 0, stdout: "", stderr: "" });
    await installSkills();
    expect(runMock).toHaveBeenCalledWith(
      "npx",
      ["skills", "add", "opper-ai/opper-skills"],
      { inherit: true },
    );
  });

  it("installSkills throws when the install fails", async () => {
    runMock.mockReturnValue({ code: 1, stdout: "", stderr: "boom" });
    await expect(installSkills()).rejects.toMatchObject({ code: "API_ERROR" });
  });

  it("updateSkills runs `npx skills update`", async () => {
    runMock.mockClear();
    runMock.mockReturnValue({ code: 0, stdout: "", stderr: "" });
    await updateSkills();
    expect(runMock).toHaveBeenCalledWith(
      "npx",
      ["skills", "update"],
      { inherit: true },
    );
  });
});
