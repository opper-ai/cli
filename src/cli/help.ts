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
];

export function addGroupedHelpText(program: Command): void {
  const titleWidth = Math.max(...GROUPS.map((g) => g.title.length));
  const lines = GROUPS.map((g) => {
    const padding = " ".repeat(titleWidth - g.title.length + 2);
    return `  ${g.title}${padding}${g.commands.join(", ")}`;
  });
  program.addHelpText(
    "after",
    `\nCommand groups:\n${lines.join("\n")}\n\nRun \`opper <command> --help\` for details on any command.`,
  );
}
