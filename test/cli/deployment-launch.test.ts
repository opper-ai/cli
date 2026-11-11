import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/commands/launch.js", () => ({ launchCommand: vi.fn().mockResolvedValue(0) }));
const { launchCommand } = await import("../../src/commands/launch.js");
const { default: registerAgents } = await import("../../src/cli/agents.js");
afterEach(() => vi.restoreAllMocks());
describe("deployment flags with launch passthrough", () => {
  it.each([
    ["-d", "-d"],
    ["--deployment", "--deployment"],
  ])("keeps the global %s before launch and forwards the child flag after --", async (globalFlag, childFlag) => {
    vi.mocked(launchCommand).mockResolvedValue(0);
    const program = new Command().name("opper").option("-d, --deployment <name>");
    registerAgents(program, { key: () => "evroc", version: "test" });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await program.parseAsync([globalFlag, "evroc", "launch", "claude", "--", childFlag, "child-value"], { from: "user" });
    expect(program.opts().deployment).toBe("evroc");
    expect(launchCommand).toHaveBeenLastCalledWith(expect.objectContaining({ key: "evroc", passthrough: [childFlag, "child-value"] }));
    expect(exit).toHaveBeenCalledWith(0);
  });
});
