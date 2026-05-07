import { agentsListCommand, agentsUninstallCommand } from "../commands/agents.js";
import { launchCommand } from "../commands/launch.js";
import type { RegisterFn } from "./types.js";

function collectTagPairs(
  raw: string,
  acc: Record<string, string>,
): Record<string, string> {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    throw new Error(`--tag expects key=value, got "${raw}"`);
  }
  const key = raw.slice(0, eq);
  const value = raw.slice(eq + 1);
  if (Object.prototype.hasOwnProperty.call(acc, key)) {
    throw new Error(`--tag key "${key}" specified twice`);
  }
  return { ...acc, [key]: value };
}

const register: RegisterFn = (program, ctx) => {
  const agentsCmd = program
    .command("agents")
    .description("Manage supported AI agents");

  agentsCmd
    .command("list")
    .description("List supported agents and whether each is installed")
    .action(agentsListCommand);

  agentsCmd
    .command("uninstall <name>")
    .description(
      "Remove the Opper integration from an agent's config (does not uninstall the agent itself)",
    )
    .action(async (name: string) => {
      await agentsUninstallCommand(name);
    });

  program
    .command("launch")
    .description(
      "Launch an AI agent with its inference routed through Opper. " +
        "Anything after the agent name (flags or args) is forwarded to " +
        "the agent's CLI verbatim, e.g.\n" +
        "  opper launch pi -p \"summarise this\"\n" +
        "  opper launch claude --resume",
    )
    .argument("<agent>", "agent name (e.g. hermes)")
    .option("--model <id>", "Opper model identifier")
    .option("--install", "install the agent if missing", false)
    .option(
      "--project",
      "write the Opper config into the cwd-local project config (where supported, e.g. opencode) instead of the user-level config",
      false,
    )
    .option(
      "--tag <pair>",
      "attach metadata as key=value (repeatable). Stored as a tag on every generation in this launch.",
      collectTagPairs,
      {} as Record<string, string>,
    )
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(
      async (
        agentName: string,
        cmdOpts: {
          model?: string;
          install?: boolean;
          project?: boolean;
          tag?: Record<string, string>;
        },
        cmd,
      ) => {
        const args = (cmd.args as string[]).slice(1);
        const code = await launchCommand({
          agent: agentName,
          key: ctx.key(),
          ...(cmdOpts.model ? { model: cmdOpts.model } : {}),
          ...(cmdOpts.install ? { install: true } : {}),
          ...(cmdOpts.project ? { configScope: "project" as const } : {}),
          ...(cmdOpts.tag && Object.keys(cmdOpts.tag).length > 0
            ? { tags: cmdOpts.tag }
            : {}),
          passthrough: args,
        });
        process.exit(code);
      },
    );
};

export default register;
