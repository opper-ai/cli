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
  // Mirror the real index.ts: a `version` subcommand exists.
  program.command("version").description("Print the CLI version");
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
  it("renders Commands as one block per domain group", () => {
    const help = captureHelp(buildProgram());
    expect(help).toContain("Commands:");
    for (const title of [
      "Account",
      "Skills",
      "Editors",
      "Agents",
      "Platform",
      "Misc",
    ]) {
      expect(help).toContain(`  ${title}`);
    }
    // Each command line indents under its group header (4 spaces).
    expect(help).toMatch(/ {4}login \[options\] +Authenticate with Opper/);
    expect(help).toMatch(/ {4}launch \[options\] <agent> +Launch an AI agent/);
  });

  it("hides commander's default flat command list", () => {
    const help = captureHelp(buildProgram());
    // The flat block uses two-space indentation directly under "Commands:".
    // Our grouped block uses four-space indentation under the domain header.
    // So a line starting with two spaces + a known command name should NOT
    // appear (would indicate the default block is still rendered).
    expect(help).not.toMatch(/^ {2}login \[options\]/m);
    expect(help).not.toMatch(/^ {2}launch \[options\] <agent>/m);
  });

  it("every registered command is listed in a group (no orphans)", () => {
    const program = buildProgram();
    const help = captureHelp(program);

    // Pull all command names referenced in the rendered grouped block.
    const referenced = new Set<string>();
    for (const line of help.split("\n")) {
      const match = line.match(/^ {4}(\S+)/);
      if (!match) continue;
      referenced.add(match[1]!);
    }

    // commander auto-adds `help` — that's fine to skip.
    const registered = program.commands
      .map((c) => c.name())
      .filter((n) => n !== "help");
    for (const name of registered) {
      expect(
        referenced,
        `command "${name}" is registered but not listed in any help group — add it to GROUPS in src/cli/help.ts`,
      ).toContain(name);
    }
  });
});
