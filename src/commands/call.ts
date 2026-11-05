import { OpperApi } from "../api/client.js";
import { resolveApiContext } from "../api/resolve.js";
import { DEFAULT_MODELS } from "../config/models.js";
import { OpperError } from "../errors.js";

export interface CallOptions {
  name: string;
  instructions: string;
  input: string;
  key: string;
  projectUuid?: string | undefined;
  model?: string;
  stream?: boolean;
  maxTokens?: number;
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** A chat completion, or one frame of its stream. */
interface CompletionFrame {
  model?: string;
  choices?: {
    message?: { content?: string | null };
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }[];
  usage?: Usage | null;
  cost?: number;
  error?: { message?: string } | string;
}

function parseFrame(payload: string): CompletionFrame | null {
  try {
    return JSON.parse(payload) as CompletionFrame;
  } catch {
    return null;
  }
}

function usageLine(model: string, usage: Usage | undefined, cost: number | undefined): string | null {
  const parts: string[] = [];
  if (usage) {
    parts.push(`${usage.prompt_tokens ?? 0} input + ${usage.completion_tokens ?? 0} output = ${usage.total_tokens ?? 0} tokens`);
  }
  if (typeof cost === "number") parts.push(`$${cost.toFixed(6)}`);
  return parts.length > 0 ? `${model}: ${parts.join(", ")}` : null;
}

/** A failed call ends in process.exit, which drops whatever stdout still has queued. */
function flushStdout(): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write("", () => resolve());
  });
}

/**
 * One model call for shell scripts: the answer goes to stdout, usage and cost
 * to stderr, and an answer that did not finish exits non-zero.
 */
export async function callCommand(opts: CallOptions): Promise<void> {
  // fetch throws on a header it cannot encode and the client would report that
  // as a network failure.
  if (!/^[\x20-\x7e]*$/.test(opts.name)) {
    throw new OpperError(
      "INVALID_ARGUMENT",
      "The call name must be printable ASCII.",
      "It is sent as the X-Opper-Name header.",
    );
  }

  const ctx = await resolveApiContext(opts.key, { projectUuid: opts.projectUuid });
  const api = new OpperApi(ctx);

  const requestedModel = opts.model ?? DEFAULT_MODELS.sonnet;
  const body = {
    model: requestedModel,
    messages: [
      { role: "system", content: opts.instructions },
      { role: "user", content: opts.input },
    ],
    ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
  };
  const headers = { "X-Opper-Name": opts.name };

  let answered = false;
  let finishReason: string | undefined;
  let failure: string | undefined;
  let model = requestedModel;
  let usage: Usage | undefined;
  let cost: number | undefined;

  const take = (frame: CompletionFrame): void => {
    if (frame.model) model = frame.model;
    if (frame.usage) usage = frame.usage;
    if (typeof frame.cost === "number") cost = frame.cost;
    if (frame.error) {
      const message = typeof frame.error === "string" ? frame.error : frame.error.message;
      failure = message ?? "The model call failed";
    }
    const choice = frame.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const text = choice?.delta?.content ?? choice?.message?.content;
    if (text) {
      process.stdout.write(text);
      answered = true;
    }
  };

  if (opts.stream) {
    const frames = api.stream(
      "/v3/compat/chat/completions",
      { ...body, stream: true, stream_options: { include_usage: true } },
      headers,
    );
    for await (const payload of frames) {
      const frame = parseFrame(payload);
      if (frame) take(frame);
    }
  } else {
    take(await api.post<CompletionFrame>("/v3/compat/chat/completions", body, headers));
  }

  if (answered) process.stdout.write("\n");
  const line = usageLine(model, usage, cost);
  if (line) process.stderr.write(`${line}\n`);
  await flushStdout();

  if (failure) throw new OpperError("API_ERROR", failure);
  if (finishReason === "length") {
    throw new OpperError(
      "API_ERROR",
      "The answer was cut off at the token limit (finish_reason: length).",
      `${answered ? "What the model wrote before the limit is on stdout. " : ""}Raise the limit with --max-tokens, send less input, or pick another model with --model.`,
    );
  }
  if (!finishReason) {
    throw new OpperError("API_ERROR", "The response ended before the model finished.", "Try again.");
  }
  if (finishReason !== "stop") {
    throw new OpperError("API_ERROR", `The model stopped before finishing its answer (finish_reason: ${finishReason}).`);
  }
  if (!answered) {
    throw new OpperError("API_ERROR", "The model returned an empty answer.", "Try again, or pass --model to pick another model.");
  }
}
