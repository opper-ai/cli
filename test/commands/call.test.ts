import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";
import { DEFAULT_MODELS } from "../../src/config/models.js";

const postMock = vi.fn();
const streamMock = vi.fn();
vi.mock("../../src/api/client.js", () => ({
  OpperApi: vi.fn(() => ({ post: postMock, stream: streamMock })),
}));

const { callCommand } = await import("../../src/commands/call.js");
const { OpperApi } = await import("../../src/api/client.js");

useTempOpperHome();

const CHAT = "/v3/compat/chat/completions";

function completion(content: string | null, finishReason: string | null = "stop"): unknown {
  return {
    model: "gpt-x",
    choices: [{ message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
    cost: 0.000123,
  };
}

async function* frames(...payloads: unknown[]): AsyncIterable<string> {
  for (const p of payloads) yield typeof p === "string" ? p : JSON.stringify(p);
}

const usageFrame = {
  model: "gpt-x",
  choices: [],
  usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
  cost: 0.000123,
};

describe("callCommand", () => {
  let out: string;
  let err: string;
  let previousKey: string | undefined;

  function capture(onChunk: (chunk: string) => void) {
    return ((chunk: string | Uint8Array, a?: unknown, b?: unknown) => {
      onChunk(String(chunk));
      const done = typeof a === "function" ? a : b;
      if (typeof done === "function") done();
      return true;
    }) as typeof process.stdout.write;
  }

  beforeEach(async () => {
    previousKey = process.env.OPPER_API_KEY;
    delete process.env.OPPER_API_KEY;
    postMock.mockReset();
    streamMock.mockReset();
    vi.mocked(OpperApi).mockClear();
    out = "";
    err = "";
    vi.spyOn(process.stdout, "write").mockImplementation(capture((c) => { out += c; }));
    vi.spyOn(process.stderr, "write").mockImplementation(capture((c) => { err += c; }));
    await setSlot("default", { apiKey: "k" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousKey === undefined) delete process.env.OPPER_API_KEY;
    else process.env.OPPER_API_KEY = previousKey;
  });

  const call = { name: "greet", instructions: "say hi", input: "world", key: "default" };

  it("sends instructions as the system message, input as the user message, the name as X-Opper-Name", async () => {
    postMock.mockResolvedValue(completion("hello"));

    await callCommand(call);

    const [path, body, headers] = postMock.mock.calls[0]!;
    expect(path).toBe(CHAT);
    expect(body.messages).toEqual([
      { role: "system", content: "say hi" },
      { role: "user", content: "world" },
    ]);
    expect(headers).toEqual({ "X-Opper-Name": "greet" });
    expect(body).not.toHaveProperty("name");
    expect(body).not.toHaveProperty("instructions");
    expect(body).not.toHaveProperty("input");
  });

  it("uses the default model without --model, and --model when given", async () => {
    postMock.mockResolvedValue(completion("x"));

    await callCommand(call);
    await callCommand({ ...call, model: "claude-opus-5" });

    expect(postMock.mock.calls[0]![1].model).toBe(DEFAULT_MODELS.sonnet);
    expect(postMock.mock.calls[1]![1].model).toBe("claude-opus-5");
  });

  it("writes only the answer to stdout, usage and cost only to stderr", async () => {
    postMock.mockResolvedValue(completion("hello world"));

    await callCommand(call);

    expect(out).toBe("hello world\n");
    expect(err).toBe("gpt-x: 12 input + 34 output = 46 tokens, $0.000123\n");
  });

  it("leaves out the cost when the response has none", async () => {
    postMock.mockResolvedValue({ ...(completion("x") as object), cost: undefined });

    await callCommand(call);

    expect(err).toBe("gpt-x: 12 input + 34 output = 46 tokens\n");
  });

  it("writes nothing to stderr when the response has neither usage nor cost", async () => {
    postMock.mockResolvedValue({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] });

    await callCommand(call);

    expect(out).toBe("x\n");
    expect(err).toBe("");
  });

  it("--stream writes deltas to stdout as they come and asks for usage", async () => {
    streamMock.mockReturnValue(frames(
      { model: "gpt-x", choices: [{ delta: { role: "assistant" } }] },
      { model: "gpt-x", choices: [{ delta: { content: "hel" } }] },
      { model: "gpt-x", choices: [{ delta: { content: "lo" } }] },
      { model: "gpt-x", choices: [{ delta: {}, finish_reason: "stop" }], cost: 0.000123 },
      usageFrame,
    ));

    await callCommand({ ...call, stream: true });

    const [path, body, headers] = streamMock.mock.calls[0]!;
    expect(path).toBe(CHAT);
    expect(body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(headers).toEqual({ "X-Opper-Name": "greet" });
    expect(out).toBe("hello\n");
    expect(err).toBe("gpt-x: 12 input + 34 output = 46 tokens, $0.000123\n");
  });

  it("--stream keeps stdout clean when a frame is not JSON", async () => {
    streamMock.mockReturnValue(frames(
      "not json",
      { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
    ));

    await callCommand({ ...call, stream: true });

    expect(out).toBe("ok\n");
  });

  it("a cut-off answer fails after printing what the model wrote and its usage", async () => {
    postMock.mockResolvedValue(completion("partial", "length"));

    await expect(callCommand(call)).rejects.toMatchObject({
      code: "API_ERROR",
      message: expect.stringContaining("finish_reason: length"),
    });

    expect(out).toBe("partial\n");
    expect(err).toContain("46 tokens");
  });

  it("--stream: a cut-off answer fails after printing what the model wrote and its usage", async () => {
    streamMock.mockReturnValue(frames(
      { choices: [{ delta: { content: "partial" } }] },
      { choices: [{ delta: {}, finish_reason: "length" }] },
      usageFrame,
    ));

    await expect(callCommand({ ...call, stream: true })).rejects.toMatchObject({
      code: "API_ERROR",
      message: expect.stringContaining("finish_reason: length"),
    });

    expect(out).toBe("partial\n");
    expect(err).toContain("46 tokens");
  });

  it("any other finish reason than stop fails and names the reason", async () => {
    postMock.mockResolvedValue(completion("partial", "content_filter"));

    await expect(callCommand(call)).rejects.toMatchObject({
      code: "API_ERROR",
      message: expect.stringContaining("finish_reason: content_filter"),
    });
  });

  it("--stream: a stream that closes without a finish reason fails", async () => {
    streamMock.mockReturnValue(frames({ choices: [{ delta: { content: "par" } }] }));

    await expect(callCommand({ ...call, stream: true })).rejects.toMatchObject({ code: "API_ERROR" });

    expect(out).toBe("par\n");
  });

  it("--stream: an error frame fails with its message", async () => {
    streamMock.mockReturnValue(frames(
      { choices: [{ delta: { content: "par" } }] },
      { error: { message: "upstream broke", code: "server_error" }, cost: 0.5 },
    ));

    await expect(callCommand({ ...call, stream: true })).rejects.toMatchObject({
      code: "API_ERROR",
      message: "upstream broke",
    });
  });

  it("an empty answer fails and prints nothing to stdout", async () => {
    postMock.mockResolvedValue(completion(""));

    await expect(callCommand(call)).rejects.toMatchObject({
      code: "API_ERROR",
      message: expect.stringContaining("empty answer"),
    });

    expect(out).toBe("");
  });

  it("refuses a name a header cannot carry before calling the API", async () => {
    await expect(callCommand({ ...call, name: "sammanfattning på svenska" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(callCommand({ ...call, name: "a\nb" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });

    expect(postMock).not.toHaveBeenCalled();
  });

  it("runs at organization scope: no project is required and a resource default does not apply", async () => {
    postMock.mockResolvedValue(completion("x"));
    await setSlot("default", {
      apiKey: "k",
      source: "device-flow",
      orgId: 7,
      defaultProjectUuid: "11111111-1111-4111-8111-111111111111",
    });

    await callCommand(call);

    expect(vi.mocked(OpperApi).mock.calls[0]![0].projectUuid).toBeUndefined();
  });

  it("sends an explicit --project-uuid", async () => {
    postMock.mockResolvedValue(completion("x"));
    const projectUuid = "22222222-2222-4222-8222-222222222222";

    await callCommand({ ...call, projectUuid });

    expect(vi.mocked(OpperApi).mock.calls[0]![0].projectUuid).toBe(projectUuid);
  });
});
