import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import registerAgents, { collectTagPairs } from "../../src/cli/agents.js";

const commands = vi.hoisted(() => ({ configure: vi.fn(), remove: vi.fn(), launch: vi.fn(), list: vi.fn() }));
vi.mock("../../src/commands/agents.js", () => ({
  agentsConfigureCommand: commands.configure, agentsRemoveCommand: commands.remove, agentsListCommand: commands.list,
}));
vi.mock("../../src/commands/launch.js", () => ({ launchCommand: commands.launch }));

function program(): Command {
  const cli = new Command().exitOverride().option("--key <slot>", "", "default");
  cli.configureOutput({ writeErr: () => {} });
  registerAgents(cli, { key: () => cli.opts().key, version: "test" });
  return cli;
}

describe("agent command options", () => {
  beforeEach(() => {
    for (const command of Object.values(commands)) command.mockReset().mockResolvedValue(undefined);
    commands.launch.mockResolvedValue(0);
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("parses --codex-home for configure together with the selected key and model", async () => {
    await program().parseAsync(["--key", "prod", "agents", "configure", "codex-desktop", "--codex-home", "/tmp/Codex Home", "--model", "claude-sonnet-5"], { from: "user" });
    expect(commands.configure).toHaveBeenCalledExactlyOnceWith("codex-desktop", "prod", "claude-sonnet-5", "/tmp/Codex Home");
  });

  it("parses --codex-home for removal", async () => {
    await program().parseAsync(["agents", "remove", "codex-desktop", "--codex-home=/tmp/Codex Home"], { from: "user" });
    expect(commands.remove).toHaveBeenCalledExactlyOnceWith("codex-desktop", "/tmp/Codex Home");
  });

  it("consumes --codex-home on launch instead of forwarding it to the app", async () => {
    await program().parseAsync(["launch", "codex-desktop", "--codex-home", "/tmp/Codex Home", "--model", "claude-sonnet-5"], { from: "user" });
    expect(commands.launch).toHaveBeenCalledExactlyOnceWith({
      agent: "codex-desktop", key: "default", codexHome: "/tmp/Codex Home", model: "claude-sonnet-5", passthrough: [],
    });
  });

  it("leaves native --home untouched for other launched agents", async () => {
    await program().parseAsync(["launch", "codex", "--home", "/tmp/Native Home"], { from: "user" });
    expect(commands.launch).toHaveBeenCalledExactlyOnceWith({
      agent: "codex", key: "default", passthrough: ["--home", "/tmp/Native Home"],
    });
  });

  it("preserves explicitly separated native arguments", async () => {
    await program().parseAsync(["launch", "codex", "--", "--codex-home", "/tmp/native"], { from: "user" });
    expect(commands.launch).toHaveBeenCalledExactlyOnceWith({
      agent: "codex", key: "default", passthrough: ["--codex-home", "/tmp/native"],
    });
  });
});

describe("collectTagPairs", () => {
  it("accepts a key=value pair and returns it merged into the accumulator", () => {
    const result = collectTagPairs("customer=acme", {});
    expect(result).toEqual({ customer: "acme" });
  });

  it("merges into an existing accumulator without mutating it", () => {
    const acc = { team: "eu" };
    const result = collectTagPairs("customer=acme", acc);
    expect(result).toEqual({ team: "eu", customer: "acme" });
    // The previous accumulator is left untouched (Commander relies on the
    // returned value being the new accumulator).
    expect(acc).toEqual({ team: "eu" });
  });

  it("rejects a value with no '=' separator", () => {
    expect(() => collectTagPairs("nokey", {})).toThrow(/expects key=value/);
  });

  it("rejects an empty key (=value form)", () => {
    expect(() => collectTagPairs("=value", {})).toThrow(/expects key=value/);
  });

  it("rejects the multi-pair shorthand (key=value,key=value)", () => {
    expect(() =>
      collectTagPairs("team=eu,customer=acme", {}),
    ).toThrow(/multiple pairs/);
  });

  it("preserves a plain comma inside a value", () => {
    expect(collectTagPairs("customer=Acme, Inc", {})).toEqual({
      customer: "Acme, Inc",
    });
  });

  it("rejects a duplicate key on a second call", () => {
    const acc = collectTagPairs("team=eu", {});
    expect(() => collectTagPairs("team=us", acc)).toThrow(
      /"team" specified twice/,
    );
  });

  it("preserves '=' inside the value", () => {
    const result = collectTagPairs("filter=a=b", {});
    expect(result).toEqual({ filter: "a=b" });
  });
});
