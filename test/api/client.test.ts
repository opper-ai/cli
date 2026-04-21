import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpperApi } from "../../src/api/client.js";

describe("OpperApi", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends Bearer auth and JSON body on POST", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ hello: "world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const api = new OpperApi({
      baseUrl: "https://api.opper.ai",
      apiKey: "op_live_abc",
    });
    const result = await api.post<{ hello: string }>("/v3/call", { name: "x" });

    expect(result.hello).toBe("world");
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe("https://api.opper.ai/v3/call");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer op_live_abc",
    );
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(init.body).toBe(JSON.stringify({ name: "x" }));
  });

  it("parses JSON on GET", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const api = new OpperApi({ baseUrl: "https://api.opper.ai", apiKey: "k" });
    const result = await api.get<{ items: unknown[] }>("/v3/functions");
    expect(result.items).toEqual([]);
  });

  it("handles 204 No Content on DELETE", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(null, { status: 204 }),
    ) as unknown as typeof fetch;
    const api = new OpperApi({ baseUrl: "https://api.opper.ai", apiKey: "k" });
    await expect(api.del("/v3/functions/foo")).resolves.toBeUndefined();
  });

  it("maps 401 to OpperError AUTH_EXPIRED", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("unauthorized", { status: 401 }),
    ) as unknown as typeof fetch;
    const api = new OpperApi({ baseUrl: "https://api.opper.ai", apiKey: "k" });
    await expect(api.get("/v3/models")).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
    });
  });

  it("maps other non-2xx to API_ERROR and extracts error.message when present", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { message: "function not found", type: "not_found" } }),
        { status: 404, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const api = new OpperApi({ baseUrl: "https://api.opper.ai", apiKey: "k" });
    await expect(api.get("/v3/functions/ghost")).rejects.toMatchObject({
      code: "API_ERROR",
      message: expect.stringContaining("function not found"),
    });
  });

  it("maps fetch rejection to NETWORK_ERROR", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    const api = new OpperApi({ baseUrl: "https://api.opper.ai", apiKey: "k" });
    await expect(api.get("/v3/models")).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });

  it("streams SSE data lines as an async iterator", async () => {
    const body = [
      "data: {\"delta\":\"hello\"}",
      "",
      "data: {\"delta\":\" world\"}",
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    globalThis.fetch = vi.fn(async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    ) as unknown as typeof fetch;

    const api = new OpperApi({ baseUrl: "https://api.opper.ai", apiKey: "k" });
    const chunks: string[] = [];
    for await (const chunk of api.stream("/v3/call/stream", { name: "x" })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(['{"delta":"hello"}', '{"delta":" world"}']);
  });

  it("streams data: without space separator", async () => {
    const body = [
      "data:{\"delta\":\"no\"}",
      "",
      "data:{\"delta\":\" space\"}",
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    globalThis.fetch = vi.fn(async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    ) as unknown as typeof fetch;

    const api = new OpperApi({ baseUrl: "https://api.opper.ai", apiKey: "k" });
    const chunks: string[] = [];
    for await (const chunk of api.stream("/v3/call/stream", { name: "x" })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(['{"delta":"no"}', '{"delta":" space"}']);
  });

  it("sends PATCH with JSON body", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "m_1", name: "new" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const api = new OpperApi({ baseUrl: "https://api.opper.ai", apiKey: "k" });
    const result = await api.patch<{ id: string; name: string }>(
      "/v2/models/custom/m_1",
      { name: "new" },
    );
    expect(result.id).toBe("m_1");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ name: "new" }));
  });
});
