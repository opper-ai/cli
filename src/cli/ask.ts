import { askCommand } from "../commands/ask.js";
import type { RegisterFn } from "./types.js";

const register: RegisterFn = (program, ctx) => {
  program
    .command("ask")
    .description("Ask the Opper support agent for help, grounded on bundled docs")
    .argument("<question...>", "your question (quoting optional)")
    .option("--model <id>", "Opper model identifier")
    .action(async (questionParts: string[], cmdOpts: { model?: string }) => {
      const question = questionParts.join(" ").trim();
      await askCommand({
        question,
        key: ctx.key(),
        ...(cmdOpts.model ? { model: cmdOpts.model } : {}),
      });
    });
};

export default register;
