import { agentsListCommand, agentsUninstallCommand } from "../commands/agents.js";
import { launchCommand } from "../commands/launch.js";
import type { RegisterFn } from "./types.js";

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
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (agentName: string, cmdOpts: { model?: string; install?: boolean }, cmd) => {
      const args = (cmd.args as string[]).slice(1);
      const code = await launchCommand({
        agent: agentName,
        key: ctx.key(),
        ...(cmdOpts.model ? { model: cmdOpts.model } : {}),
        ...(cmdOpts.install ? { install: true } : {}),
        passthrough: args,
      });
      process.exit(code);
    });
};

export default register;
