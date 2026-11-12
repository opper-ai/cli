import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";
import { EXIT_CODES, OpperError } from "../../src/errors.js";
import { chatCommand } from "../../src/commands/chat.js";

useTempOpperHome();
const model = "anthropic/claude-haiku-5-5";
const projectUuid = "11111111-1111-4111-8111-111111111111";
const fetchMock = vi.fn<typeof fetch>();
let output: string;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function completion(content = "Hello from Opper"): Response {
  return jsonResponse({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
}
function sseResponse(frames: unknown[]): Response {
  const text = frames.map((frame) => `data: ${frame === "[DONE]" ? frame : JSON.stringify(frame)}\r\n\r\n`).join("");
  // Split within both SSE lines and multibyte text to exercise the real client decoder.
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
function delta(content: string, finishReason: string | null = null): unknown {
  return { choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] };
}
async function expectFailure(action: Promise<void>, code?: string): Promise<void> {
  const error: unknown = await action.then(() => undefined, (err: unknown) => err);
  expect(error).toBeInstanceOf(OpperError);
  if (!(error instanceof OpperError)) throw new Error("Expected a typed command failure");
  expect(EXIT_CODES[error.code]).toBeGreaterThan(0);
  if (code) expect(error.code).toBe(code);
}

beforeEach(() => {
  for (const name of ["OPPER_API_KEY", "OPPER_BASE_URL", "OPPER_DEPLOYMENT"]) vi.stubEnv(name, undefined);
  output = "";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { output += `${args.map(String).join(" ")}\n`; });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output += String(chunk); return true; });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("chatCommand", () => {
  it.each([
    ["main", "https://api.opper.ai"],
    ["evroc", "https://api.evroc.on.opper.ai"],
  ])("uses the selected %s credential and compat contract without default project scoping", async (key, baseUrl) => {
    await setSlot(key, { apiKey: `synthetic-${key}`, baseUrl, source: "device-flow", orgId: 1, defaultProjectUuid: projectUuid });
    fetchMock.mockResolvedValue(completion());
    const prompt = "  Explain this:\n\tå 😀\n\n";
    const system = "  Be concise.\n";
    await chatCommand({ prompt, model, key, system });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/v3/compat/chat/completions`);
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer synthetic-${key}`);
    expect(headers.has("x-opper-project")).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({
      model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], stream: false,
    });
    expect(output).toBe("Hello from Opper\n");
  });

  it("sends an explicitly requested project independently of the slot's resource default", async () => {
    await setSlot("default", { apiKey: "synthetic", defaultProjectUuid: "22222222-2222-4222-8222-222222222222" });
    fetchMock.mockResolvedValue(completion());
    await chatCommand({ prompt: "Hello", model, key: "default", projectUuid });
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get("x-opper-project")).toBe(projectUuid);
  });

  it("omits the system message when none was supplied", async () => {
    await setSlot("default", { apiKey: "synthetic" });
    fetchMock.mockResolvedValue(completion());
    await chatCommand({ prompt: "Hello", model, key: "default", stream: false });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("streams standard compat deltas, allowing role and usage frames, through stop and DONE", async () => {
    await setSlot("default", { apiKey: "synthetic" });
    fetchMock.mockResolvedValue(sseResponse([
      { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
      delta("Héllo "), delta("😀"), delta("", "stop"),
      { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }, "[DONE]",
    ]));
    await chatCommand({ prompt: "Hi", model, key: "default", stream: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.opper.ai/v3/compat/chat/completions");
    expect(JSON.parse(String(init?.body))).toEqual({ model, messages: [{ role: "user", content: "Hi" }], stream: true });
    expect(new Headers(init?.headers).get("accept")).toBe("text/event-stream");
    expect(output).toBe("Héllo 😀\n");
  });

  it("rejects missing or blank prompt/model before authentication or network access", async () => {
    for (const invalid of [{ model: undefined }, { model: " \n" }, { prompt: undefined }, { prompt: "\t\n " }]) {
      const options = { prompt: "Hello", model, key: "missing", ...invalid } as Parameters<typeof chatCommand>[0];
      await expectFailure(chatCommand(options), "INVALID_ARGUMENT");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates HTTP authentication and API failures without printing an answer", async () => {
    await setSlot("default", { apiKey: "synthetic" });
    for (const [status, code] of [[401, "AUTH_EXPIRED"], [429, "API_ERROR"]] as const) {
      fetchMock.mockResolvedValue(jsonResponse({ error: { message: "Request rejected", type: "test_error" } }, status));
      await expectFailure(chatCommand({ prompt: "Hi", model, key: "default" }), code);
    }
    expect(output).toBe("");
  });

  it.each([
    ["invalid JSON or a null response", () => [new Response("not JSON", { headers: { "content-type": "application/json" } }), jsonResponse(null)]],
    ["no choices", () => [jsonResponse({ choices: [] })]],
    ["a refusal", () => [jsonResponse({ choices: [{ message: { role: "assistant", content: null, refusal: "Cannot answer" }, finish_reason: "stop" }] })]],
  ])("rejects %s as a typed failure", async (_label, response) => {
    await setSlot("default", { apiKey: "synthetic" });
    for (const invalidResponse of response()) {
      fetchMock.mockResolvedValue(invalidResponse);
      await expectFailure(chatCommand({ prompt: "Hi", model, key: "default" }));
    }
    expect(output).toBe("");
  });

  it("rejects malformed SSE frames instead of printing raw payloads", async () => {
    await setSlot("default", { apiKey: "synthetic" });
    fetchMock.mockResolvedValue(new Response("data: {broken-json}\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }));
    await expectFailure(chatCommand({ prompt: "Hi", model, key: "default", stream: true }));
    expect(output).not.toContain("broken-json");
  });

  it("rejects an in-band streaming API error", async () => {
    await setSlot("default", { apiKey: "synthetic" });
    fetchMock.mockResolvedValue(sseResponse([{ error: { message: "Provider unavailable", type: "provider_error" } }, "[DONE]"]));
    await expectFailure(chatCommand({ prompt: "Hi", model, key: "default", stream: true }));
    expect(output).toBe("");
  });

  it("rejects truncated streams, including a stop frame without DONE", async () => {
    await setSlot("default", { apiKey: "synthetic" });
    for (const frames of [[delta("partial")], [delta("partial"), "[DONE]"], [delta("partial"), delta("", "stop")]]) {
      fetchMock.mockResolvedValue(sseResponse(frames));
      await expectFailure(chatCommand({ prompt: "Hi", model, key: "default", stream: true }));
    }
  });

  it("rejects a streaming refusal", async () => {
    await setSlot("default", { apiKey: "synthetic" });
    fetchMock.mockResolvedValue(sseResponse([
      { choices: [{ index: 0, delta: { refusal: "Cannot answer" }, finish_reason: null }] }, delta("", "stop"), "[DONE]",
    ]));
    await expectFailure(chatCommand({ prompt: "Hi", model, key: "default", stream: true }));
    expect(output).toBe("");
  });

  it("reports a mid-response disconnect as a typed network failure", async () => {
    await setSlot("default", { apiKey: "synthetic" });
    let sent = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta("partial"))}\n\n`));
      } else controller.error(new TypeError("Synthetic connection closed"));
    } });
    fetchMock.mockResolvedValue(new Response(body));
    await expectFailure(chatCommand({ prompt: "Hi", model, key: "default", stream: true }), "NETWORK_ERROR");
    expect(output).toBe("partial");
    expect(body.locked).toBe(false);
  });

  it("cancels and releases the response when a malformed or refusal frame ends consumption early", async () => {
    await setSlot("default", { apiKey: "synthetic" });
    for (const payload of ["{broken-json}", JSON.stringify({ choices: [{ delta: { refusal: "Cannot answer" } }] })]) {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`)); },
        cancel,
      });
      fetchMock.mockResolvedValue(new Response(body));
      await expectFailure(chatCommand({ prompt: "Hi", model, key: "default", stream: true }), "API_ERROR");
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(false);
    }
  });

  it("rejects a length-limited response as incomplete", async () => {
    await setSlot("default", { apiKey: "synthetic" });
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { role: "assistant", content: "partial" }, finish_reason: "length" }] }));
    await expectFailure(chatCommand({ prompt: "Hi", model, key: "default" }));
  });
});
