import { describe, it, expect, vi, beforeEach } from "vitest";
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
    select: vi.fn(async () => answers.shift()?.() ?? "quit"),
    isCancel: (v: unknown) => typeof v === "symbol",
    cancel: vi.fn(),
  };
});

const hermesDetect = vi.fn();
const hermesIsConfigured = vi.fn();
const hermesConfigure = vi.fn();
const hermesAdapter = {
  name: "hermes",
  displayName: "Hermes Agent",
  binary: "hermes",
  docsUrl: "https://example",
  launchable: true,
  detect: hermesDetect,
  isConfigured: hermesIsConfigured,
  configure: hermesConfigure,
  install: vi.fn(),
  snapshotConfig: vi.fn(),
  writeOpperConfig: vi.fn(),
  restoreConfig: vi.fn(),
  spawn: vi.fn(),
};
vi.mock("../../src/agents/registry.js", () => ({
  listAdapters: () => [hermesAdapter],
  getAdapter: (name: string) => (name === "hermes" ? hermesAdapter : null),
}));

const loginMock = vi.fn();
const logoutMock = vi.fn();
const whoamiMock = vi.fn();
const launchMock = vi.fn();
const setupMock = vi.fn();
const skillsListMock = vi.fn();
const editorsListMock = vi.fn();

vi.mock("../../src/commands/login.js", () => ({ loginCommand: loginMock }));
vi.mock("../../src/commands/logout.js", () => ({ logoutCommand: logoutMock }));
vi.mock("../../src/commands/whoami.js", () => ({ whoamiCommand: whoamiMock }));
vi.mock("../../src/commands/launch.js", () => ({ launchCommand: launchMock }));
vi.mock("../../src/commands/setup.js", () => ({ setupCommand: setupMock }));
vi.mock("../../src/commands/skills.js", () => ({
  skillsListCommand: skillsListMock,
  skillsInstallCommand: vi.fn(),
  skillsUpdateCommand: vi.fn(),
}));
vi.mock("../../src/commands/editors.js", () => ({
  editorsListCommand: editorsListMock,
  editorsOpenCodeCommand: vi.fn(),
  editorsContinueCommand: vi.fn(),
}));

const { menuCommand } = await import("../../src/commands/menu.js");

useTempOpperHome();

describe("menuCommand", () => {
  beforeEach(() => {
    answers.length = 0;
    hermesDetect.mockReset();
    hermesIsConfigured.mockReset();
    hermesConfigure.mockReset();
    loginMock.mockReset();
    logoutMock.mockReset();
    whoamiMock.mockReset();
    launchMock.mockReset();
    setupMock.mockReset();
    skillsListMock.mockReset();
    editorsListMock.mockReset();
  });

  it("launches the chosen adapter and returns to menu (loops to quit)", async () => {
    hermesDetect.mockResolvedValue({ installed: true });
    hermesIsConfigured.mockResolvedValue(true);
    launchMock.mockResolvedValue(0);
    answers.push(() => "launch:hermes");
    answers.push(() => "quit");

    await menuCommand({ key: "default" });
    expect(launchMock).toHaveBeenCalledWith({ agent: "hermes", key: "default" });
    expect(launchMock).toHaveBeenCalledTimes(1);
  });

  it("does not show Launch entry for an unconfigured adapter", async () => {
    hermesDetect.mockResolvedValue({ installed: true });
    hermesIsConfigured.mockResolvedValue(false);
    answers.push(() => "quit");

    await menuCommand({ key: "default" });
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("loops through multiple actions before quitting", async () => {
    hermesDetect.mockResolvedValue({ installed: false });
    hermesIsConfigured.mockResolvedValue(false);
    answers.push(() => "skills");
    answers.push(() => "setup");
    answers.push(() => "quit");

    await menuCommand({ key: "default" });
    expect(skillsListMock).toHaveBeenCalled();
    expect(setupMock).toHaveBeenCalled();
  });

  it("returns to menu (does not propagate) when an action throws", async () => {
    hermesDetect.mockResolvedValue({ installed: false });
    hermesIsConfigured.mockResolvedValue(false);
    skillsListMock.mockRejectedValueOnce(new Error("boom"));
    answers.push(() => "skills");
    answers.push(() => "quit");

    await expect(menuCommand({ key: "default" })).resolves.toBeUndefined();
    expect(skillsListMock).toHaveBeenCalled();
  });

  it("shows Sign in when no slot is stored and invokes login on select", async () => {
    hermesDetect.mockResolvedValue({ installed: false });
    hermesIsConfigured.mockResolvedValue(false);
    answers.push(() => "login");
    answers.push(() => "quit");

    await menuCommand({ key: "default" });
    expect(loginMock).toHaveBeenCalledWith({ key: "default" });
  });

  it("shows Account entry when a slot exists and invokes whoami", async () => {
    await setSlot("default", {
      apiKey: "op_live_x",
      user: { email: "me@example.com", name: "Me" },
    });
    hermesDetect.mockResolvedValue({ installed: false });
    hermesIsConfigured.mockResolvedValue(false);
    answers.push(() => "whoami");
    answers.push(() => "quit");

    await menuCommand({ key: "default" });
    expect(whoamiMock).toHaveBeenCalledWith({ key: "default" });
  });

  it("invokes setup on select", async () => {
    hermesDetect.mockResolvedValue({ installed: false });
    hermesIsConfigured.mockResolvedValue(false);
    answers.push(() => "setup");
    answers.push(() => "quit");

    await menuCommand({ key: "default" });
    expect(setupMock).toHaveBeenCalledWith({ key: "default" });
  });

  it("quits silently on quit", async () => {
    hermesDetect.mockResolvedValue({ installed: false });
    hermesIsConfigured.mockResolvedValue(false);
    answers.push(() => "quit");

    await menuCommand({ key: "default" });
    expect(launchMock).not.toHaveBeenCalled();
    expect(loginMock).not.toHaveBeenCalled();
  });

  it("agents submenu configures an unconfigured agent", async () => {
    hermesDetect.mockResolvedValue({ installed: true });
    hermesIsConfigured.mockResolvedValue(false);
    answers.push(() => "agents");
    answers.push(() => "agent:hermes");
    answers.push(() => "back");
    answers.push(() => "quit");

    await menuCommand({ key: "default" });
    expect(hermesConfigure).toHaveBeenCalled();
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("agents submenu launches an already-configured launchable agent", async () => {
    hermesDetect.mockResolvedValue({ installed: true });
    hermesIsConfigured.mockResolvedValue(true);
    launchMock.mockResolvedValue(0);
    answers.push(() => "agents");
    answers.push(() => "agent:hermes");
    answers.push(() => "back");
    answers.push(() => "quit");

    await menuCommand({ key: "default" });
    expect(launchMock).toHaveBeenCalledWith({ agent: "hermes", key: "default" });
  });
});
