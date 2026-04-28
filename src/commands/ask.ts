import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, SilentLogger, setDefaultLogger } from "@opperai/agents";
import { z } from "zod";
import { spinner } from "@clack/prompts";
import { resolveApiContext } from "../api/resolve.js";
import { OpperError } from "../errors.js";
import { brand } from "../ui/colors.js";
import { DEFAULT_MODELS } from "../config/models.js";

export interface AskOptions {
  question: string;
  key: string;
  model?: string;
}

const OutputSchema = z.object({
  answer: z.string().describe("The answer in plain markdown — examples first, prose second."),
});

const SYSTEM_PROMPT = `You are the Opper CLI's built-in support agent.

You answer questions about the Opper platform: authentication, the v3 API,
the Python and Node SDKs (both classic and agent flavours), the CLI itself,
indexes, traces, usage analytics, image generation, and how to route AI
coding agents (Claude Code, OpenCode, Codex, Hermes, Pi) through Opper.

Ground your answers in the bundled documentation snippets below. If a
question falls outside this knowledge or the docs don't cover it, say so
plainly and point the user at https://docs.opper.ai or
https://github.com/opper-ai/cli rather than guessing.

Keep answers tight: examples first, prose second. Use fenced code blocks
for shell commands and source snippets. Don't restate the question.`;

function bundledSkillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "data", "skills");
}

/**
 * Load every bundled SKILL.md (and adjacent reference docs) as context for
 * the agent. Each skill becomes a labelled section.
 */
function loadSkillCorpus(): string {
  const root = bundledSkillsDir();
  if (!existsSync(root)) return "";

  const sections: string[] = [];
  for (const skill of readdirSync(root).sort()) {
    const skillDir = join(root, skill);
    const skillFile = join(skillDir, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    sections.push(`\n## Skill: ${skill}\n\n${readFileSync(skillFile, "utf8")}`);

    const refsDir = join(skillDir, "references");
    if (existsSync(refsDir)) {
      for (const ref of readdirSync(refsDir).sort()) {
        if (!ref.endsWith(".md")) continue;
        const body = readFileSync(join(refsDir, ref), "utf8");
        sections.push(`\n### Reference: ${skill}/${ref}\n\n${body}`);
      }
    }
  }
  return sections.join("\n");
}

export async function askCommand(opts: AskOptions): Promise<void> {
  if (!opts.question.trim()) {
    throw new OpperError(
      "API_ERROR",
      "No question provided",
      "Try `opper ask \"how do I authenticate?\"`",
    );
  }

  const ctx = await resolveApiContext(opts.key);

  // Suppress the agent SDK's noisy default logger — it dumps full HTTP
  // error objects to the console when span tracing 404s on the platform,
  // which clutters the user's terminal even though the run succeeds.
  setDefaultLogger(new SilentLogger());

  const corpus = loadSkillCorpus();
  const instructions = corpus
    ? `${SYSTEM_PROMPT}\n\n# Bundled Opper documentation\n${corpus}`
    : SYSTEM_PROMPT;

  // Only override baseUrl when the user has set a non-default. The opperai
  // SDK defaults to https://api.opper.ai/v2; passing our bare-host
  // DEFAULT_BASE_URL would strip the /v2 path and 404 on /spans.
  const isCustomBaseUrl =
    ctx.baseUrl !== undefined && ctx.baseUrl !== "https://api.opper.ai";

  const agent = new Agent<string, z.infer<typeof OutputSchema>>({
    name: "OpperAsk",
    instructions,
    tools: [],
    model: opts.model ?? DEFAULT_MODELS.sonnet,
    outputSchema: OutputSchema,
    opperConfig: {
      apiKey: ctx.apiKey,
      baseUrl: isCustomBaseUrl ? ctx.baseUrl : undefined,
    },
  });

  const s = spinner();
  s.start("Thinking");
  let result: z.infer<typeof OutputSchema>;
  let usage: { totalTokens: number; requests: number };
  try {
    const r = await agent.run(opts.question);
    result = r.result;
    usage = { totalTokens: r.usage.totalTokens, requests: r.usage.requests };
  } catch (err) {
    s.stop("Failed");
    throw err;
  }
  s.stop("Done");

  process.stdout.write(`\n${result.answer}\n`);
  process.stdout.write(
    `\n${brand.dim(
      `(${usage.totalTokens} tokens · ${usage.requests} request${
        usage.requests === 1 ? "" : "s"
      })`,
    )}\n`,
  );
}
