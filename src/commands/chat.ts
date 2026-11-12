import { OpperApi } from "../api/client.js";
import { resolveApiContext } from "../api/resolve.js";
import { OpperError } from "../errors.js";

export interface ChatOptions {
  prompt: string;
  model: string;
  key: string;
  system?: string;
  stream?: boolean;
  projectUuid?: string | undefined;
}

interface ChatResponse {
  error?: { message?: string } | string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null; refusal?: string | null };
    delta?: { content?: string | null; refusal?: string | null };
  }>;
}

function responseError(response: ChatResponse): void {
  if (!response || typeof response !== "object" || Array.isArray(response)
    || (response.choices !== undefined && !Array.isArray(response.choices))) {
    throw new OpperError("API_ERROR", "Received an invalid model response.");
  }
  if (response.error) throw new OpperError("API_ERROR", typeof response.error === "string"
    ? response.error : response.error.message ?? "The model request failed.");
}

function checkFinish(reason: string | null | undefined): void {
  if (reason !== "stop") throw new OpperError("API_ERROR", `The model did not complete a text response (${reason ?? "missing finish reason"}).`,
    "Try another model or shorten the prompt.");
}

export async function chatCommand(opts: ChatOptions): Promise<void> {
  if (!opts.model?.trim()) throw new OpperError("INVALID_ARGUMENT", "A model is required.", "Pass -m <model>; use `opper models list` to find models.");
  if (!opts.prompt?.trim()) throw new OpperError("INVALID_ARGUMENT", "No prompt provided.", "Pass a prompt or pipe input to `opper chat -m <model>`.");
  const context = await resolveApiContext(opts.key, { projectUuid: opts.projectUuid });
  const api = new OpperApi(context);
  const body = {
    model: opts.model,
    messages: [
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      { role: "user", content: opts.prompt },
    ],
    stream: !!opts.stream,
  };
  if (!opts.stream) {
    let result: ChatResponse;
    try { result = await api.post<ChatResponse>("/v3/compat/chat/completions", body); }
    catch (error) {
      if (error instanceof SyntaxError) throw new OpperError("API_ERROR", "Received invalid JSON from the model API.");
      throw error;
    }
    responseError(result);
    const choice = result.choices?.[0];
    if (choice?.message?.refusal) throw new OpperError("API_ERROR", `The model refused the request: ${choice.message.refusal}`);
    checkFinish(choice?.finish_reason);
    if (typeof choice?.message?.content !== "string" || !choice.message.content) throw new OpperError("API_ERROR", "The model returned no text response.");
    process.stdout.write(choice.message.content + "\n");
    return;
  }
  let text = false;
  let finish: string | null | undefined;
  for await (const payload of api.stream("/v3/compat/chat/completions", body, { requireDone: true })) {
    let frame: ChatResponse;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      frame = parsed as ChatResponse;
    } catch { throw new OpperError("API_ERROR", "Received an invalid streaming response."); }
    responseError(frame);
    const choice = frame.choices?.[0];
    // Usage-only frames have no choices.
    if (!choice) continue;
    if (choice.delta?.refusal) throw new OpperError("API_ERROR", `The model refused the request: ${choice.delta.refusal}`);
    const content = choice.delta?.content;
    if (content != null && typeof content !== "string") throw new OpperError("API_ERROR", "Received an invalid streaming text response.");
    if (content) { process.stdout.write(content); text = true; }
    if (choice.finish_reason != null) { checkFinish(choice.finish_reason); finish = choice.finish_reason; }
  }
  checkFinish(finish);
  if (!text) throw new OpperError("API_ERROR", "The model returned no text response.");
  process.stdout.write("\n");
}
