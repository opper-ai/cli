import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spinner } from "@clack/prompts";
import { OpperApi } from "../api/client.js";
import { resolveApiContext } from "../api/resolve.js";
import { OpperError } from "../errors.js";
import { brand } from "../ui/colors.js";
import { DEFAULT_MODELS } from "../config/models.js";
import { installedTargets } from "../setup/skills.js";

export interface AskOptions {
  question: string;
  key: string;
  projectUuid?: string | undefined;
  model?: string;
}

/** One frame of the OpenAI-compatible chat completions stream. */
interface ChatCompletionChunk {
  choices?: { delta?: { content?: string | null } }[];
  usage?: { total_tokens?: number } | null;
  error?: { message?: string } | string;
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

  const corpus = loadSkillCorpus();
  if (!corpus) {
    throw new OpperError(
      "API_ERROR",
      "Opper skills aren't installed",
      "Run `opper skills install` to fetch them from opper-ai/opper-skills, then try again.",
    );
  }
  const instructions = `${SYSTEM_PROMPT}\n\n# Opper documentation\n${corpus}`;

  const api = new OpperApi(ctx);
  const s = spinner();
  s.start("Thinking");
  let printed = 0;
  let totalTokens = 0;

  try {
    const frames = api.stream("/v3/compat/chat/completions", {
      model: opts.model ?? DEFAULT_MODELS.sonnet,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: opts.question },
      ],
    });
    for await (const payload of frames) {
      let chunk: ChatCompletionChunk;
      try {
        chunk = JSON.parse(payload) as ChatCompletionChunk;
      } catch {
        continue;
      }
      if (chunk.error) {
        const message = typeof chunk.error === "string" ? chunk.error : chunk.error.message;
        throw new OpperError("API_ERROR", message ?? "The model stream failed");
      }
      if (chunk.usage?.total_tokens) totalTokens = chunk.usage.total_tokens;
      const delta = chunk.choices?.[0]?.delta?.content;
      if (!delta) continue;
      if (printed === 0) {
        s.stop("");
        process.stdout.write("\n");
      }
      process.stdout.write(delta);
      printed += delta.length;
    }
  } catch (err) {
    s.stop("Failed");
    throw err;
  }

  if (printed === 0) {
    s.stop("Done");
    throw new OpperError("API_ERROR", "The model returned an empty answer", "Try again, or pass --model to pick another model.");
  }

  process.stdout.write(`\n\n${brand.dim(`(${totalTokens} tokens)`)}\n`);
}
