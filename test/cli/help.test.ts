import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { addGroupedHelpText } from "../../src/cli/help.js";
import registerAuth from "../../src/cli/auth.js";
import registerSkills from "../../src/cli/skills.js";
import registerEditors from "../../src/cli/editors.js";
import registerAgents from "../../src/cli/agents.js";
import registerPlatform from "../../src/cli/platform.js";

function buildProgram(): Command {
  const program = new Command();
  program.name("opper").option("--key <slot>", "", "default");
  const ctx = { key: () => "default", version: "0.0.0-test" };
  for (const register of [
    registerAuth,
    registerSkills,
    registerEditors,
    registerAgents,
    registerPlatform,
  ]) {
    register(program, ctx);
  }
  addGroupedHelpText(program);
  return program;
}

function captureHelp(program: Command): string {
  let buffer = "";
  program.configureOutput({
    writeOut: (s) => {
      buffer += s;
    },
    writeErr: (s) => {
      buffer += s;
    },
  });
  program.outputHelp();
  return buffer;
}

describe("addGroupedHelpText", () => {
  it("emits a Command groups section with each domain", () => {
    const program = buildProgram();
    const help = captureHelp(program);
    expect(help).toContain("Command groups:");
    for (const title of ["Account", "Skills", "Editors", "Agents", "Platform"]) {
      expect(help).toContain(title);
    }
  });

  it("every command listed in a group is actually registered", () => {
    const program = buildProgram();
    const help = captureHelp(program);
    const groupsBlock = help.split("Command groups:")[1] ?? "";
    const referenced = new Set<string>();
    for (const line of groupsBlock.split("\n")) {
      const match = line.match(/^\s{2}\S+\s+(.+)$/);
      if (!match) continue;
      for (const cmd of match[1]!.split(",")) {
        const trimmed = cmd.trim();
        if (trimmed) referenced.add(trimmed);
      }
    }
    const registered = new Set(program.commands.map((c) => c.name()));
    for (const name of referenced) {
      expect(
        registered,
        `command "${name}" listed in help groups but not registered`,
      ).toContain(name);
    }
  });
});
