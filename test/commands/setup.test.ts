import { describe, it, expect, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const answers: Array<() => unknown> = [];

vi.mock("@clack/prompts", async () => {
  const actual = await vi.importActual<typeof import("@clack/prompts")>(
    "@clack/prompts",
  );
  return {
    ...actual,
    intro: vi.fn(),
    outro: vi.fn(),
    log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
    select: vi.fn(async () => answers.shift()?.() ?? "exit"),
    confirm: vi.fn(async () => answers.shift()?.() ?? false),
    isCancel: (v: unknown) => typeof v === "symbol",
    cancel: vi.fn(),
  };
});

const skillsMocks = {
  skillsInstallCommand: vi.fn(),
  skillsUpdateCommand: vi.fn(),
  skillsListCommand: vi.fn(),
};
vi.mock("../../src/commands/skills.js", () => skillsMocks);

const editorsMocks = {
  editorsListCommand: vi.fn(),
  editorsOpenCodeCommand: vi.fn(),
  editorsContinueCommand: vi.fn(),
};
vi.mock("../../src/commands/editors.js", () => editorsMocks);

const loginMock = vi.fn();
vi.mock("../../src/commands/login.js", () => ({ loginCommand: loginMock }));

const { setupCommand } = await import("../../src/commands/setup.js");

useTempOpperHome();

describe("setup wizard", () => {
  it("runs skills and opencode when the user picks them, then exits", async () => {
    await setSlot("default", { apiKey: "op_live_x" });
    answers.length = 0;
    answers.push(
      () => "skills",
      () => "opencode",
      () => "exit",
    );
    await setupCommand({ key: "default" });
    expect(skillsMocks.skillsInstallCommand).toHaveBeenCalled();
    expect(editorsMocks.editorsOpenCodeCommand).toHaveBeenCalled();
    expect(loginMock).not.toHaveBeenCalled();
  });

  it("runs login when there is no stored slot and the user agrees", async () => {
    answers.length = 0;
    answers.push(
      () => true,
      () => "exit",
    );
    await setupCommand({ key: "default" });
    expect(loginMock).toHaveBeenCalled();
  });
});
