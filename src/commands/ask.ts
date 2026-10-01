import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Agent, SilentLogger, setDefaultLogger, type OpperClient } from "@opperai/agents";
import { z } from "zod";
import { spinner } from "@clack/prompts";
import { resolveApiContext } from "../api/resolve.js";
import { OpperError } from "../errors.js";
import { brand } from "../ui/colors.js";
import { DEFAULT_MODELS } from "../config/models.js";
import { installedTargets } from "../setup/skills.js";
import { createAgentClient, getAgentGatewayFinalResult, getAgentGatewayUsage, mapAgentApiError } from "../api/agent-client.js";

export interface AskOptions {
  question: string;
  key: string;
  projectUuid?: string | undefined;
  model?: string;
}

const OutputSchema = z.object({
  answer: z.string().describe("The answer in plain markdown — examples first, prose second."),
});

/** The installed SDK coerces string leaves such as "123" during assembly. */
export function createAskOutputSchema(client: OpperClient) {
  return z.preprocess((value) => getAgentGatewayFinalResult(client) ?? value, OutputSchema);
}

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

/**
 * Load every Opper skill the user has installed (via `opper skills install`)
 * as context for the agent. Each skill becomes a labelled section. We
 * dedup across the Claude/Codex targets — they're the same content, just
 * different install paths.
 */
function loadSkillCorpus(): string {
  const seen = new Set<string>();
  const sections: string[] = [];

  for (const target of installedTargets()) {
    const root = target.dir;
    if (!existsSync(root)) continue;

    for (const skill of target.installed) {
      if (seen.has(skill)) continue;
      seen.add(skill);

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

  const ctx = await resolveApiContext(opts.key, { projectUuid: opts.projectUuid, useDefaultProject: true, requireProject: true });

  // Suppress the agent SDK's noisy default logger — span tracing 404s on
  // the platform side spam the terminal even when the run succeeds.
  setDefaultLogger(new SilentLogger());

  const corpus = loadSkillCorpus();
  if (!corpus) {
    throw new OpperError(
      "API_ERROR",
      "Opper skills aren't installed",
      "Run `opper skills install` to fetch them from opper-ai/opper-skills, then try again.",
    );
  }
  const instructions = `${SYSTEM_PROMPT}\n\n# Opper documentation\n${corpus}`;

  const s = spinner();
  s.start("Thinking");
  // Track how much of the answer field we've already written so we can
  // emit only the new tail on each chunk. Streaming structured output
  // gives us per-field running buffers via `fieldBuffers`.
  let printed = 0;

  const opperClient = createAgentClient(ctx);
  const agent = new Agent<string, z.infer<typeof OutputSchema>>({
    name: "OpperAsk",
    instructions,
    tools: [],
    model: opts.model ?? DEFAULT_MODELS.sonnet,
    outputSchema: createAskOutputSchema(opperClient),
    enableStreaming: true,
    onStreamChunk: ({ chunkData }) => {
      // Single-iteration tool-less agents stream the answer field under
      // callType "think" with jsonPath "finalResult.answer" — the SDK
      // tags the structured-output destination, not the agent phase.
      if (chunkData.jsonPath !== "finalResult.answer") return;
      const delta = chunkData.delta;
      if (typeof delta !== "string" || delta.length === 0) return;
      if (printed === 0) {
        s.stop("");
        process.stdout.write("\n");
      }
      process.stdout.write(delta);
      printed += delta.length;
    },
    opperClient,
  });

  let usage: { totalTokens: number; requests: number };
  try {
    const r = await agent.run(opts.question);
    usage = { totalTokens: r.usage.totalTokens, requests: r.usage.requests };
    if (usage.totalTokens === 0) usage = getAgentGatewayUsage(opperClient) ?? usage;
    if (printed === 0) {
      // Streaming chunks didn't fire — fall back to printing the resolved
      // answer once.
      s.stop("Done");
      process.stdout.write(`\n${r.result.answer}\n`);
    }
  } catch (err) {
    s.stop("Failed");
    throw mapAgentApiError(err);
  }

  process.stdout.write(
    `\n\n${brand.dim(
      `(${usage.totalTokens} tokens · ${usage.requests} request${
        usage.requests === 1 ? "" : "s"
      })`,
    )}\n`,
  );
}
