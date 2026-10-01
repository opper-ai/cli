import { askCommand } from "../commands/ask.js";
import type { RegisterFn } from "./types.js";

const register: RegisterFn = (program, ctx) => {
  program
    .command("ask")
    .description("Ask the Opper support agent using its named SDK function (requires an explicit or default resource project for organization keys)")
    .argument("<question...>", "your question (quoting optional)")
    .option("--model <id>", "Opper model identifier")
    .action(async (questionParts: string[], cmdOpts: { model?: string }) => {
      const question = questionParts.join(" ").trim();
      await askCommand({
        question,
        key: ctx.key(),
        ...(ctx.projectUuid?.() ? { projectUuid: ctx.projectUuid() } : {}),
        ...(cmdOpts.model ? { model: cmdOpts.model } : {}),
      });
    });
};

export default register;
