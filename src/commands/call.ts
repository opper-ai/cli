import { OpperApi } from "../api/client.js";
import { resolveApiContext } from "../api/resolve.js";

export interface CallOptions {
  name: string;
  instructions: string;
  input: string;
  key: string;
  model?: string;
}

interface RunResponse {
  data?: unknown;
  meta?: { function_name?: string; trace_uuid?: string };
}

export async function callCommand(opts: CallOptions): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);

  const body: Record<string, unknown> = {
    name: opts.name,
    instructions: opts.instructions,
    input: opts.input,
    stream: false,
  };
  if (opts.model) body.model = opts.model;

  const result = await api.post<RunResponse>("/v3/call", body);

  if (result.data === undefined || result.data === null) {
    console.log("(empty response)");
    return;
  }
  if (typeof result.data === "string") {
    console.log(result.data);
  } else {
    console.log(JSON.stringify(result.data, null, 2));
  }
}
