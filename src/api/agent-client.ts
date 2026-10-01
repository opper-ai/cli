import { OpperClient } from "@opperai/agents";
import type { ApiContext } from "./resolve.js";
import { OpperError } from "../errors.js";

const observedUsage = new WeakMap<OpperClient, { totalTokens: number; requests: number }>();
const activeStream = new WeakMap<OpperClient, object>();
const observedFinalResult = new WeakMap<object, unknown>();

/** Actual gateway metadata remains available even when ZDR prevents span lookup. */
export function getAgentGatewayUsage(client: OpperClient) {
  return observedUsage.get(client);
}

export function getAgentGatewayFinalResult(client: OpperClient): unknown {
  const request = activeStream.get(client);
  return request ? observedFinalResult.get(request) : undefined;
}

/** Keep SDK calls and span traffic on the same explicitly selected project. */
export function createAgentClient(context: ApiContext): OpperClient {
  const baseUrl = context.baseUrl.replace(/\/+$/, "") + "/v2";
  const client = new OpperClient(context.apiKey, { baseUrl });
  const structuredStreams = new WeakSet<object>();
  client.getClient()._options.hooks?.registerBeforeRequestHook({
    async beforeRequest(hookContext, request) {
      if (hookContext.operationID === "function_call_call_post") activeStream.delete(client);
      if (hookContext.operationID === "function_stream_call_stream_post") {
        activeStream.set(client, hookContext);
        const body: unknown = await request.clone().json().catch(() => undefined);
        if (isRecord(body) && body.output_schema) {
          structuredStreams.add(hookContext);
        }
      }
      return request;
    },
  });
  if (context.projectUuid) {
    // The agent SDK exposes its underlying generated SDK through getClient().
    // Its public HTTPClient hook applies to both call and tracing requests.
    const projectUuid = context.projectUuid;
    client.getClient()._options.httpClient?.addHook("beforeRequest", (request) => {
      request.headers.set("X-Opper-Project", projectUuid);
      return request;
    });
  }
  // The gateway can serve /v2/call through its v3 named-function executor.
  // Normalize only that envelope for the installed agent SDK, whose generated
  // client still expects the legacy response. Its public SDK hook preserves
  // request bodies, transport errors, native v2 replies, and streaming.
  client.getClient()._options.hooks?.registerAfterSuccessHook({
    async afterSuccess(hookContext, response) {
      if (hookContext.operationID === "function_stream_call_stream_post" && structuredStreams.has(hookContext) &&
          response.headers.get("content-type")?.includes("text/event-stream") && response.body) {
        return adaptStructuredStream(response, (meta) => {
          if (!isRecord(meta.usage)) return;
          const input = meta.usage.input_tokens;
          const output = meta.usage.output_tokens;
          if (typeof input !== "number" || typeof output !== "number") return;
          const previous = observedUsage.get(client) ?? { totalTokens: 0, requests: 0 };
          observedUsage.set(client, { totalTokens: previous.totalTokens + input + output, requests: previous.requests + 1 });
        }, (value) => observedFinalResult.set(hookContext, value));
      }
      if (hookContext.operationID !== "function_call_call_post" || !response.headers.get("content-type")?.includes("application/json")) return response;
      const body: unknown = await response.clone().json().catch(() => undefined);
      if (!isRecord(body) || "span_id" in body || !("data" in body) || !isRecord(body.meta)) return response;
      const meta = body.meta;
      // Empty is the SDK's supported absence sentinel: the agent skips span
      // updates for falsy IDs. Never invent a span ID from a trace ID under ZDR.
      const spanId = meta.span_uuid ?? meta.span_id;
      const normalized = {
        span_id: typeof spanId === "string" ? spanId : "",
        ...(typeof body.data === "string" ? { message: body.data } : { json_payload: body.data }),
        ...(isRecord(meta.usage) ? { usage: meta.usage } : {}),
        ...(typeof meta.cost === "number" ? { cost: { total: meta.cost } } : isRecord(meta.cost) ? { cost: meta.cost } : {}),
      };
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response(JSON.stringify(normalized), { status: response.status, statusText: response.statusText, headers });
    },
  });
  return client;
}

/** Translate gateway fields only; legacy json_path packets stay intact. */
function adaptStructuredStream(response: Response, onMeta: (meta: Record<string, unknown>) => void, onFinalResult: (value: unknown) => void): Response {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      drain(controller, false);
    },
    flush(controller) {
      buffer += decoder.decode();
      drain(controller, true);
    },
  });
  function drain(controller: TransformStreamDefaultController<Uint8Array>, final: boolean) {
    let separator: RegExpExecArray | null;
    while ((separator = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      emit(frame, controller);
    }
    if (final && buffer) { emit(buffer, controller); buffer = ""; }
  }
  function emit(frame: string, controller: TransformStreamDefaultController<Uint8Array>) {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    let body: unknown;
    try { body = JSON.parse(data); } catch { controller.enqueue(encoder.encode(frame + "\n\n")); return; }
    if (!isRecord(body)) { controller.enqueue(encoder.encode(frame + "\n\n")); return; }
    if (isRecord(body.meta)) onMeta(body.meta);
    if ("json_path" in body || typeof body.type !== "string") {
      controller.enqueue(encoder.encode(frame + "\n\n"));
      return;
    }
    // Raw content and JSON-literal field_delta fragments duplicate completed
    // fields. The SDK needs decoded leaves, including nested finalResult.answer.
    if (body.type === "field_complete" && typeof body.field_path === "string") {
      if (body.field_path === "finalResult") onFinalResult(body.field_value);
      for (const [jsonPath, delta] of fieldLeaves(body.field_path, body.field_value)) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta, json_path: jsonPath, chunk_type: "json" })}\n\n`));
      }
    } else if (body.type === "error") {
      const message = typeof body.error === "string" ? body.error :
        isRecord(body.error) && typeof body.error.message === "string" ? body.error.message :
        typeof body.message === "string" ? body.message : "Gateway streaming request failed";
      controller.error(new Error(message));
    }
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(response.body!.pipeThrough(transform), { status: response.status, statusText: response.statusText, headers });
}

function fieldLeaves(path: string, value: unknown): Array<[string, string | number | boolean]> {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [[path, value]];
  // Empty collections are supplied by the agent decision schema's defaults.
  if (Array.isArray(value)) return value.flatMap((entry, index) => fieldLeaves(`${path}.${index}`, entry));
  if (isRecord(value)) return Object.entries(value).flatMap(([key, entry]) => fieldLeaves(`${path}.${key}`, entry));
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Translate the installed SDK's HTTP error without changing call semantics. */
export function mapAgentApiError(error: unknown): unknown {
  if (error === null || typeof error !== "object") return error;
  const sdkError = error as { headers?: Headers; body?: string };
  let body: { code?: string; error?: { type?: string; code?: string } } | undefined;
  try { if (sdkError.body) body = JSON.parse(sdkError.body); } catch { /* non-JSON SDK error */ }
  if (sdkError.headers?.get?.("X-Opper-Error-Code") === "project_required" || body?.code === "project_required" ||
      body?.error?.type === "project_required" || body?.error?.code === "project_required") {
    return new OpperError("PROJECT_REQUIRED", "This command requires a project.",
      "Pass --project-uuid <uuid>, or set a resource default with `opper config project <slot> <uuid>`.");
  }
  return error;
}
