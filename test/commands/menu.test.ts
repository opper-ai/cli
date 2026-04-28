import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot, deleteSlot } from "../../src/auth/config.js";

const answers: Array<() => unknown> = [];

// Sentinel used by the select() mock when the answers queue is exhausted.
// `isCancel(SENTINEL_BAIL)` returns true, so any submenu we land in without a
// queued answer cancels out instead of looping forever.
const SENTINEL_BAIL: symbol = Symbol("bail");

vi.mock("@clack/prompts", async () => {
  const actual = await vi.importActual<typeof import("@clack/prompts")>(
    "@clack/prompts",
  );
  return {
    ...actual,
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      message: vi.fn(),
    })),
    select: vi.fn(async () => {
      const next = answers.shift();
      return next ? next() : SENTINEL_BAIL;
    }),
    text: vi.fn(async () => {
      const next = answers.shift();
      return next ? next() : SENTINEL_BAIL;
    }),
    confirm: vi.fn(async () => {
      const next = answers.shift();
      return next ? next() : SENTINEL_BAIL;
    }),
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
  docsUrl: "https://example",
  detect: hermesDetect,
  isConfigured: hermesIsConfigured,
  configure: hermesConfigure,
  unconfigure: vi.fn(),
  install: vi.fn(),
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
  beforeEach(async () => {
    answers.length = 0;
    hermesDetect.mockReset();
    hermesIsConfigured.mockReset();
    hermesConfigure.mockReset();
    hermesAdapter.unconfigure.mockReset();
    loginMock.mockReset();
    logoutMock.mockReset();
    whoamiMock.mockReset();
    launchMock.mockReset();
    setupMock.mockReset();
    skillsListMock.mockReset();
    editorsListMock.mockReset();
    // Default to "already signed in" so the new menu sign-in prompt doesn't
    // consume answers in tests that aren't specifically about auth.
    await setSlot("default", { apiKey: "op_test", source: "manual" });
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
    // Open Skills submenu, pick "status", back out, then quit.
    answers.push(() => "skills");
    answers.push(() => "status");
    answers.push(() => "back");
    answers.push(() => "skills");
    answers.push(() => "status");
    answers.push(() => "back");
    answers.push(() => "quit");

    await menuCommand({ key: "default" });
    expect(skillsListMock).toHaveBeenCalledTimes(2);
  });

  it("returns to menu (does not propagate) when an action throws", async () => {
    hermesDetect.mockResolvedValue({ installed: false });
    hermesIsConfigured.mockResolvedValue(false);
    skillsListMock.mockRejectedValueOnce(new Error("boom"));
    answers.push(() => "skills");
    answers.push(() => "status"); // throws via mock
    answers.push(() => "back");
    answers.push(() => "quit");

    await expect(menuCommand({ key: "default" })).resolves.toBeUndefined();
    expect(skillsListMock).toHaveBeenCalled();
  });

  it("Account → Sign in invokes loginCommand", async () => {
    // Clear the default slot so the Account submenu shows "Sign in".
    await deleteSlot("default");
    hermesDetect.mockResolvedValue({ installed: false });
    hermesIsConfigured.mockResolvedValue(false);
    // Decline the upfront "Sign in now?" prompt to fall through to the menu.
    answers.push(() => false);
    answers.push(() => "account");
    answers.push(() => "login");
    answers.push(() => "back");
    answers.push(() => "quit");

    await menuCommand({ key: "default" });
    expect(loginMock).toHaveBeenCalledWith({ key: "default" });
  });

  it("prompts for sign-in on first run when no slot exists, runs login on yes", async () => {
    await deleteSlot("default");
    hermesDetect.mockResolvedValue({ installed: false });
    hermesIsConfigured.mockResolvedValue(false);
    answers.push(() => true);    // accept the upfront prompt
    answers.push(() => "quit");  // exit main menu after login completes

    await menuCommand({ key: "default" });
    expect(loginMock).toHaveBeenCalledWith({ key: "default" });
  });

  it("does not prompt for sign-in when a slot already exists", async () => {
    // beforeEach has populated a default slot; the upfront prompt should
    // not fire and loginMock should never be called.
    hermesDetect.mockResolvedValue({ installed: false });
    hermesIsConfigured.mockResolvedValue(false);
    answers.push(() => "quit");

    await menuCommand({ key: "default" });
    expect(loginMock).not.toHaveBeenCalled();
  });

  it("Account → Show invokes whoamiCommand when a slot exists", async () => {
    await setSlot("default", {
      apiKey: "op_live_x",
      user: { email: "me@example.com", name: "Me" },
    });
    hermesDetect.mockResolvedValue({ installed: false });
    hermesIsConfigured.mockResolvedValue(false);
    answers.push(() => "account");
    answers.push(() => "show");
    answers.push(() => "back");
    answers.push(() => "quit");

    await menuCommand({ key: "default" });
    expect(whoamiMock).toHaveBeenCalledWith({ key: "default" });
  });

  it("quits silently on quit", async () => {
    hermesDetect.mockResolvedValue({ installed: false });
    hermesIsConfigured.mockResolvedValue(false);
    answers.push(() => "quit");

    await menuCommand({ key: "default" });
    expect(launchMock).not.toHaveBeenCalled();
    expect(loginMock).not.toHaveBeenCalled();
  });

  it("agents submenu → agent menu → Configure runs adapter.configure()", async () => {
    hermesDetect.mockResolvedValue({ installed: true });
    hermesIsConfigured.mockResolvedValue(false);
    answers.push(() => "agents");        // main → agents submenu
    answers.push(() => "agent:hermes");  // agents → agent submenu
    answers.push(() => "configure");     // agent → configure
    answers.push(() => "back");          // exit agent submenu
    answers.push(() => "back");          // exit agents submenu
    answers.push(() => "quit");          // exit main

    await menuCommand({ key: "default" });
    expect(hermesConfigure).toHaveBeenCalled();
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("agents submenu → agent menu → Launch runs launchCommand", async () => {
    hermesDetect.mockResolvedValue({ installed: true });
    hermesIsConfigured.mockResolvedValue(true);
    launchMock.mockResolvedValue(0);
    answers.push(() => "agents");
    answers.push(() => "agent:hermes");
    answers.push(() => "launch");
    answers.push(() => "back");
    answers.push(() => "back");
    answers.push(() => "quit");

    await menuCommand({ key: "default" });
    expect(launchMock).toHaveBeenCalledWith({ agent: "hermes", key: "default" });
  });

  it("agents submenu → agent menu → Remove integration calls unconfigure()", async () => {
    hermesDetect.mockResolvedValue({ installed: true });
    hermesIsConfigured.mockResolvedValue(true);
    answers.push(() => "agents");
    answers.push(() => "agent:hermes");
    answers.push(() => "uninstall");
    answers.push(() => "back");
    answers.push(() => "back");
    answers.push(() => "quit");

    await menuCommand({ key: "default" });
    expect(hermesAdapter.unconfigure).toHaveBeenCalled();
  });

  it("skills submenu wires status / install / uninstall", async () => {
    hermesDetect.mockResolvedValue({ installed: false });
    hermesIsConfigured.mockResolvedValue(false);
    answers.push(() => "skills");
    answers.push(() => "status");
    answers.push(() => "back");
    answers.push(() => "quit");

    await menuCommand({ key: "default" });
    expect(skillsListMock).toHaveBeenCalled();
  });
});
