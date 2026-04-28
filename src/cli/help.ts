import type { Command } from "commander";

interface HelpGroup {
  title: string;
  commands: string[];
}

const GROUPS: HelpGroup[] = [
  {
    title: "Account",
    commands: ["login", "logout", "whoami", "config"],
  },
  {
    title: "Help",
    commands: ["ask"],
  },
  {
    title: "Skills",
    commands: ["skills"],
  },
  {
    title: "Editors",
    commands: ["editors"],
  },
  {
    title: "Agents",
    commands: ["agents", "launch"],
  },
  {
    title: "Platform",
    commands: [
      "call",
      "functions",
      "models",
      "indexes",
      "traces",
      "usage",
      "image",
    ],
  },
  {
    title: "Misc",
    commands: ["version"],
  },
];

/**
 * Replace commander's flat `Commands:` block with a per-domain grouped one.
 * Each command's term and description are rendered the same way commander
 * would render them, so columns line up with the rest of the help output.
 */
export function addGroupedHelpText(program: Command): void {
  // Suppress the default flat command list — we render a grouped one below.
  program.configureHelp({ visibleCommands: () => [] });

  program.addHelpText("after", () => renderGroupedCommands(program));
}

function renderGroupedCommands(program: Command): string {
  const helper = program.createHelp();
  const byName = new Map<string, Command>();
  for (const cmd of program.commands) byName.set(cmd.name(), cmd);

  const visibleCmds = GROUPS.flatMap((g) =>
    g.commands.map((n) => byName.get(n)).filter((c): c is Command => !!c),
  );
  if (visibleCmds.length === 0) return "";

  const termWidth = Math.max(
    ...visibleCmds.map((c) => helper.subcommandTerm(c).length),
  );

  const lines: string[] = ["", "Commands:"];
  for (const group of GROUPS) {
    const cmds = group.commands
      .map((n) => byName.get(n))
      .filter((c): c is Command => !!c);
    if (cmds.length === 0) continue;

    lines.push("");
    lines.push(`  ${group.title}`);
    for (const cmd of cmds) {
      const term = helper.subcommandTerm(cmd).padEnd(termWidth);
      const desc = helper.subcommandDescription(cmd);
      lines.push(`    ${term}  ${desc}`);
    }
  }
  return lines.join("\n");
}
