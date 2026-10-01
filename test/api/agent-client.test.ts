import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentClient, getAgentGatewayFinalResult, getAgentGatewayUsage, mapAgentApiError } from "../../src/api/agent-client.js";
import { Agent, SilentLogger } from "@opperai/agents";
import { createAskOutputSchema } from "../../src/commands/ask.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("agent SDK project routing", () => {
  it("keeps decoded results on their request and uses real completion usage under ZDR", async () => {
    const first = 'data: {"type":"field_complete","field_path":"finalResult","field_value":{"answer":"first"},"delta":""}\n\nevent: complete\ndata: {"meta":{"usage":{"input_tokens":11,"output_tokens":5}}}\n\n';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(first, { headers: { "Content-Type": "text/event-stream" } }))
      .mockResolvedValueOnce(new Response('data: {"delta":"second","json_path":"finalResult.answer"}\n\n', { headers: { "Content-Type": "text/event-stream" } })));
    const client = createAgentClient({ apiKey: "synthetic", baseUrl: "https://gateway.example" });
    const stream = await client.stream({ name: "ask", input: "hello", outputSchema: { type: "object" } });
    for await (const _ of stream.result) { /* complete the first request */ }
    expect(getAgentGatewayFinalResult(client)).toEqual({ answer: "first" });
    expect(getAgentGatewayUsage(client)).toEqual({ totalTokens: 16, requests: 1 });
    const next = await client.stream({ name: "ask", input: "hello", outputSchema: { type: "object" } });
    expect(getAgentGatewayFinalResult(client)).toBeUndefined();
    for await (const _ of next.result) { /* consume legacy reply */ }
    expect(getAgentGatewayFinalResult(client)).toBeUndefined();
  });
  it("does not apply a preceding stream's decoded result to a later JSON call", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response('data: {"type":"field_complete","field_path":"finalResult","field_value":{"answer":"first"},"delta":""}\n\n', { headers: { "Content-Type": "text/event-stream" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { answer: "second" }, meta: {} }), { headers: { "Content-Type": "application/json" } })));
    const client = createAgentClient({ apiKey: "synthetic", baseUrl: "https://gateway.example" });
    const stream = await client.stream({ name: "ask", input: "hello", outputSchema: { type: "object" } });
    for await (const _ of stream.result) { /* finish stream */ }
    expect(getAgentGatewayFinalResult(client)).toEqual({ answer: "first" });
    const reply = await client.call({ name: "ask", input: "hello", outputSchema: { type: "object" } });
    expect(createAskOutputSchema(client).parse(reply.jsonPayload)).toEqual({ answer: "second" });
  });
  it.each(["123", "false", "null", ""])("preserves decoded ask answer %j through the installed Agent", async (answer) => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      requests.push(request.clone());
      if (!request.url.endsWith("/call/stream")) return new Response(JSON.stringify({ id: "span-1", name: "ask" }), { headers: { "Content-Type": "application/json" } });
      const fields = { reasoning: "acceptance", isComplete: true, finalResult: { answer } };
      return new Response(Object.entries(fields).map(([field_path, field_value]) => `data: ${JSON.stringify({ type: "field_complete", delta: "", field_path, field_value })}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
    }));
    const client = createAgentClient({ apiKey: "synthetic", baseUrl: "https://gateway.example", projectUuid: "11111111-1111-4111-8111-111111111111" });
    const streamed: unknown[] = [];
    const agent = new Agent({ name: "OpperAsk", model: "test/model", tools: [], enableStreaming: true, logger: new SilentLogger(), opperClient: client,
      outputSchema: createAskOutputSchema(client), onStreamChunk: ({ chunkData }) => { if (chunkData.jsonPath === "finalResult.answer") streamed.push(chunkData.delta); } });
    await expect(agent.run("hello")).resolves.toMatchObject({ result: { answer } });
    expect(streamed).toEqual([answer]);
    const streamRequest = requests.find((request) => request.url.endsWith("/call/stream"))!;
    expect(streamRequest.headers.get("X-Opper-Project")).toBe("11111111-1111-4111-8111-111111111111");
    expect(await streamRequest.json()).toMatchObject({ name: "think_opperask", output_schema: { properties: { finalResult: { properties: { answer: { type: "string" } } } } } });
  });
  it("accepts the actual gateway envelope without inventing an ID when retention is disabled", async () => {
    const actualEnvelope = { data: "local provider success", meta: { function_name: "CLI SDK named ask acceptance", script_cached: false, execution_ms: 4, llm_calls: 1, tts_calls: 0, image_gen_calls: 0, models_used: ["anthropic/org-key-e2e"], usage: { input_tokens: 11, output_tokens: 5 }, cost: 0.000021 } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(actualEnvelope), { headers: { "Content-Type": "application/json", "X-Opper-Trace-Id": "actual-trace-is-not-a-span" } })));
    const client = createAgentClient({ apiKey: "synthetic", baseUrl: "https://gateway.example" });
    const result = await client.call({ name: "CLI SDK named ask acceptance", instructions: "hello", input: "hello" });
    expect(result).toMatchObject({ message: "local provider success", spanId: "", usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16, cost: { total: 0.000021 } } });
  });

  it("keeps structured output and an actual span UUID from gateway metadata", async () => {
    const spanUuid = "11111111-1111-4111-8111-111111111111";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: { answer: "answer" }, meta: { span_uuid: spanUuid } }), { headers: { "Content-Type": "application/json" } })));
    const client = createAgentClient({ apiKey: "synthetic", baseUrl: "https://gateway.example" });
    await expect(client.call({ name: "ask", instructions: "hello", input: "hello" })).resolves.toMatchObject({ jsonPayload: { answer: "answer" }, spanId: spanUuid });
  });

  it("leaves native streaming deltas and JSON paths compatible with the installed SDK", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('data: {"delta":"answer","json_path":"finalResult.answer","chunk_type":"json"}\n\n', { headers: { "Content-Type": "text/event-stream" } })));
    const client = createAgentClient({ apiKey: "synthetic", baseUrl: "https://gateway.example" });
    const stream = await client.stream({ name: "ask", instructions: "hello", input: "hello", outputSchema: { type: "object" } });
    const chunks = [];
    for await (const event of stream.result) chunks.push(event);
    expect(chunks).toEqual([{ data: { delta: "answer", jsonPath: "finalResult.answer", chunkType: "json" } }]);
  });
  it("translates actual gateway completed fields across UTF-8 and SSE chunk boundaries", async () => {
    const frames = [
      { type: "content", delta: '{"reasoning":"local acceptance"}' },
      { type: "field_delta", field_path: "reasoning", delta: '"local' },
      { type: "field_complete", field_path: "reasoning", field_value: "local acceptance", delta: "" },
      { type: "field_complete", field_path: "toolCalls", field_value: [], delta: "" },
      { type: "field_complete", field_path: "isComplete", field_value: true, delta: "" },
      { type: "field_complete", field_path: "falseValue", field_value: false, delta: "" },
      { type: "field_complete", field_path: "zeroValue", field_value: 0, delta: "" },
      { type: "field_complete", field_path: "emptyValue", field_value: "", delta: "" },
      { type: "field_complete", field_path: "finalResult", field_value: { answer: 'Hej åäö "answer"' }, delta: "" },
    ].map((data) => `data: ${JSON.stringify(data)}\r\n\r\n`).join("");
    const bytes = new TextEncoder().encode(frames);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7));
      controller.close();
    } }), { headers: { "Content-Type": "text/event-stream" } })));
    const client = createAgentClient({ apiKey: "synthetic", baseUrl: "https://gateway.example" });
    const stream = await client.stream({ name: "ask", instructions: "hello", input: "hello", outputSchema: { type: "object" } });
    const chunks = [];
    for await (const event of stream.result) chunks.push(event);
    expect(chunks.map((event) => event.data)).toEqual([
      { delta: "local acceptance", jsonPath: "reasoning", chunkType: "json" },
      { delta: true, jsonPath: "isComplete", chunkType: "json" },
      { delta: false, jsonPath: "falseValue", chunkType: "json" },
      { delta: 0, jsonPath: "zeroValue", chunkType: "json" },
      { delta: "", jsonPath: "emptyValue", chunkType: "json" },
      { delta: 'Hej åäö "answer"', jsonPath: "finalResult.answer", chunkType: "json" },
    ]);
  });
  it("provides actionable project guidance for a projectless environment credential", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { type: "project_required", message: "project required" } }), { status: 400, headers: { "Content-Type": "application/json", "X-Opper-Error-Code": "project_required" } })));
    const client = createAgentClient({ apiKey: "env-key", baseUrl: "https://gateway.example" });
    await expect(client.call({ name: "ask", instructions: "help", input: "question" }).catch((error: unknown) => { throw mapAgentApiError(error); }))
      .rejects.toMatchObject({ code: "PROJECT_REQUIRED", hint: expect.stringContaining("--project-uuid") });
  });
  it("fails promptly on an actual gateway stream error instead of losing its message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('data: {"type":"error","error":{"message":"provider failed"}}\n\n', { headers: { "Content-Type": "text/event-stream" } })));
    const client = createAgentClient({ apiKey: "synthetic", baseUrl: "https://gateway.example" });
    const stream = await client.stream({ name: "ask", input: "hello", outputSchema: { type: "object" } });
    await expect(async () => { for await (const _ of stream.result) { /* consume */ } }).rejects.toThrow("provider failed");
  });
  it("routes the installed SDK's named calls and spans to the same explicit project", async () => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      requests.push(request.clone());
      const data = request.url.endsWith("/spans") ? { id: "span-1", name: "ask" } : { span_id: "span-2", message: "answer" };
      return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
    }));
    const projectUuid = "11111111-1111-4111-8111-111111111111";
    const client = createAgentClient({ apiKey: "synthetic", baseUrl: "https://gateway.example/", projectUuid });
    await expect(client.createSpan({ name: "ask" })).resolves.toMatchObject({ id: "span-1" });
    await expect(client.call({ name: "opper/ask", instructions: "help", input: "question" })).resolves.toMatchObject({ message: "answer" });
    expect(requests.map((request) => request.url)).toEqual(["https://gateway.example/v2/spans", "https://gateway.example/v2/call"]);
    for (const request of requests) {
      expect(request.headers.get("Authorization")).toBe("Bearer synthetic");
      expect(request.headers.get("X-Opper-Project")).toBe(projectUuid);
    }
    expect(await requests[1]!.json()).toMatchObject({ name: "opper/ask", input: "question" });
  });
});
