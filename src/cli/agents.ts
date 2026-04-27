import { agentsListCommand } from "../commands/agents.js";
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

  program
    .command("launch")
    .description("Launch an AI agent with its inference routed through Opper")
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
