import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import registerDesktop from "../../src/cli/desktop.js";
import { desktopStartCommand, desktopTagCommand, desktopStatusCommand, desktopClearCommand, desktopOpenCommand, desktopStopCommand } from "../../src/commands/desktop.js";

vi.mock("../../src/commands/desktop.js", () => ({
  desktopStartCommand: vi.fn(), desktopTagCommand: vi.fn(),
  desktopStatusCommand: vi.fn(), desktopClearCommand: vi.fn(),
  desktopOpenCommand: vi.fn(), desktopStopCommand: vi.fn(),
}));

const context = { key: () => "work", version: "test", projectUuid: () => undefined };
function run(args: string[]) {
  const program = new Command().exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerDesktop(program, context);
  return program.parseAsync(args, { from: "user" });
}

describe("desktop CLI", () => {
  beforeEach(() => vi.clearAllMocks());
  it("opens the session picker by default with the selected slot", async () => {
    await run(["desktop", "--state-dir", "/tmp/test", "--no-open"]);
    expect(desktopOpenCommand).toHaveBeenCalledWith({key: "work", stateDir: "/tmp/test", open: false});
  });
  it("registers explicit open and service stop", async () => {
    await run(["desktop", "open", "--state-dir", "/tmp/test", "--no-open"]);
    await run(["desktop", "stop", "--state-dir", "/tmp/test"]);
    expect(desktopOpenCommand).toHaveBeenCalledWith({key: "work", stateDir: "/tmp/test", open: false});
    expect(desktopStopCommand).toHaveBeenCalledWith({stateDir: "/tmp/test"});
  });
  it("starts a foreground bridge with selected slot, state and tags", async () => {
    await run(["desktop", "start", "--state-dir", "/tmp/test", "--port", "0", "--tag", "project=acme", "--tag", "team=ops"]);
    expect(desktopStartCommand).toHaveBeenCalledWith({ key: "work", stateDir: "/tmp/test", port: 0, tags: { project: "acme", team: "ops" } });
  });
  it("replaces the active tags using the running bridge's state directory", async () => {
    await run(["desktop", "tag", "--state-dir", "/tmp/test", "--tag", "project=beta"]);
    expect(desktopTagCommand).toHaveBeenCalledWith({ stateDir: "/tmp/test", tags: { project: "beta" } });
  });
  it("registers status and clear", async () => {
    await run(["desktop", "status"]);
    await run(["desktop", "clear", "--state-dir", "/tmp/test"]);
    expect(desktopStatusCommand).toHaveBeenCalledWith({});
    expect(desktopClearCommand).toHaveBeenCalledWith({ stateDir: "/tmp/test" });
  });
  it.each(["-1", "65536", "2.5", "abc"])("rejects invalid port %s", async (port) => {
    await expect(run(["desktop", "start", "--port", port])).rejects.toThrow();
    expect(desktopStartCommand).not.toHaveBeenCalled();
  });
  it("requires tag selection rather than silently clearing", async () => {
    await expect(run(["desktop", "tag"])).rejects.toThrow();
    expect(desktopTagCommand).not.toHaveBeenCalled();
  });
  it("rejects repeated tag keys", async () => {
    await expect(run(["desktop", "tag", "--tag", "project=a", "--tag", "project=b"])).rejects.toThrow();
    expect(desktopTagCommand).not.toHaveBeenCalled();
  });
});
