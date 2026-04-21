# Plan 4 of 4 — Platform Commands (v3 API) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the platform-management surface of the CLI backed by the Opper v3 API — `call`, `models list`, `functions list/get/delete`, `traces list/get/delete`, and a `config` subcommand tree for users who prefer manual API-key management over device flow.

**Architecture:** A thin, typed HTTP client in `src/api/client.ts` wraps `fetch` with `Authorization: Bearer`, structured error handling, and a helper for SSE streaming. Each platform command calls the client and formats the response. No external SDK: `@opperai/sdk` exists but the v3 surface is small enough to hand-roll and avoid an extra dependency in the tarball.

**Tech Stack:** Inherited (TypeScript, Node ≥20.10, Vitest, commander, @clack/prompts, kleur, yaml). No new runtime deps. Tests mock `fetch` at the module level.

**Depends on:** Plans 1–3. Specifically `getSlot()`, `OpperError`, `brand`, `setSlot`, `deleteSlot`, `readConfig`, `writeConfig`, the global `--key` option.

**Spec:** `docs/superpowers/specs/2026-04-21-unified-opper-cli-design.md` — §7 (command surface), §8 (error codes), §9 Phase 2 (parity commands), §13 (v3 base URL).

**Base URL:** `https://api.opper.ai` (configurable per slot via `baseUrl`). Paths include the `/v3/` prefix.

---

## Scope decisions based on the v3 OpenAPI spec

The v3 surface is smaller than the legacy Go CLI's v1 surface. We ship what exists in v3 and explicitly defer the rest:

- **In scope (v3 has endpoints):**
  - `POST /v3/call` + `POST /v3/call/stream` → `opper call`
  - `GET /v3/models` → `opper models list` (read-only)
  - `GET /v3/functions` + `GET/DELETE /v3/functions/{name}` → `opper functions list/get/delete`
  - `GET /v3/traces` + `GET/DELETE /v3/traces/{id}` → `opper traces list/get/delete`
  - Local-only `opper config` subcommands → `add/list/get/remove`

- **Out of scope (no v3 endpoint today):**
  - `opper models create/get/delete/test/builtin` — v3 has only `GET /v3/models`; CRUD-style custom model registration from the Go CLI is not part of v3 and is intentionally dropped.
  - `opper indexes` — no v3 path.
  - `opper usage` — no v3 path.
  - `opper image generate` — no dedicated endpoint; images go through `call` with an image model.
  - `opper functions evaluations run/list` — no v3 path.

These can be added in a later plan once the v3 API grows.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/api/client.ts` | `OpperApi` class — baseUrl, apiKey, fetch wrapper, JSON helpers, SSE streaming helper |
| `src/api/resolve.ts` | `resolveApiContext(key)` — reads slot + `OPPER_API_KEY` / `OPPER_BASE_URL` env overrides into a `{ baseUrl, apiKey }` tuple |
| `src/ui/table.ts` | Simple fixed-width table printer used by list commands |
| `src/commands/call.ts` | `opper call <name> <instructions> [input]` |
| `src/commands/models.ts` | `opper models list` |
| `src/commands/functions.ts` | `opper functions list/get/delete` |
| `src/commands/traces.ts` | `opper traces list/get/delete` |
| `src/commands/config.ts` | `opper config add/list/get/remove` |
| `test/api/client.test.ts` | |
| `test/api/resolve.test.ts` | |
| `test/ui/table.test.ts` | |
| `test/commands/call.test.ts` | |
| `test/commands/models.test.ts` | |
| `test/commands/functions.test.ts` | |
| `test/commands/traces.test.ts` | |
| `test/commands/config.test.ts` | |
| `src/index.ts` | Wired with the six new command blocks |
| `README.md` | Document the new commands |

Total: 14 tasks.

---

## Task 1: HTTP client

**Files:**
- Create: `src/api/client.ts`
- Create: `test/api/client.test.ts`

The client takes `{ baseUrl, apiKey }` and exposes `get`, `post`, `del` returning parsed JSON, plus a `stream` helper that returns an async iterator over SSE `data:` lines. Errors map to `OpperError`:

- 401 → `AUTH_EXPIRED`
- network failure → `NETWORK_ERROR`
- all other non-2xx → `API_ERROR` with the response body's `error.message` when present

- [ ] **Step 1: Write `test/api/client.test.ts`**

```ts
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
});
```

- [ ] **Step 2: Run — expect failure**

Run: `cd /Users/joch/dev/opper-ai/cli && npm test -- api/client`
Expected: FAIL "Cannot find module".

- [ ] **Step 3: Write `src/api/client.ts`**

```ts
import { OpperError } from "../errors.js";

export interface OpperApiConfig {
  baseUrl: string;
  apiKey: string;
}

interface ErrorBody {
  error?: { message?: string; type?: string };
  detail?: string;
  message?: string;
}

export class OpperApi {
  constructor(private readonly config: OpperApiConfig) {}

  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const url = this.buildUrl(path, query);
    const res = await this.fetch(url, { method: "GET", headers: this.headers() });
    return this.parseJson<T>(res);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const url = this.buildUrl(path);
    const res = await this.fetch(url, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    return this.parseJson<T>(res);
  }

  async del(path: string): Promise<void> {
    const url = this.buildUrl(path);
    const res = await this.fetch(url, { method: "DELETE", headers: this.headers() });
    if (res.status === 204) return;
    if (!res.ok) await this.throwApiError(res);
  }

  async *stream(path: string, body: unknown): AsyncIterable<string> {
    const url = this.buildUrl(path);
    const res = await this.fetch(url, {
      method: "POST",
      headers: this.headers({
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      }),
      body: JSON.stringify(body),
    });
    if (!res.ok) await this.throwApiError(res);
    if (!res.body) return;

    const decoder = new TextDecoder();
    let buffer = "";
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line.startsWith("data: ")) {
          const payload = line.slice(6);
          if (payload === "[DONE]") return;
          yield payload;
        }
      }
    }
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const base = this.config.baseUrl.replace(/\/$/, "");
    const url = new URL(base + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      ...extra,
    };
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (err) {
      throw new OpperError(
        "NETWORK_ERROR",
        `Network request failed: ${err instanceof Error ? err.message : String(err)}`,
        "Check your internet connection and try again.",
      );
    }
  }

  private async parseJson<T>(res: Response): Promise<T> {
    if (!res.ok) await this.throwApiError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async throwApiError(res: Response): Promise<never> {
    if (res.status === 401) {
      throw new OpperError(
        "AUTH_EXPIRED",
        "API key was rejected by the server.",
        "Run `opper login --force` to re-authenticate.",
      );
    }
    let body: ErrorBody | null = null;
    const text = await res.text().catch(() => "");
    if (text) {
      try {
        body = JSON.parse(text) as ErrorBody;
      } catch {
        /* leave body null */
      }
    }
    const detail = body?.error?.message ?? body?.detail ?? body?.message ?? text;
    throw new OpperError(
      "API_ERROR",
      `HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    );
  }
}
```

- [ ] **Step 4: Run — must pass**

Run: `npm test -- api/client`
Expected: PASS (7 tests). `npm run typecheck` exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/api/client.ts test/api/client.test.ts
git commit -m "feat: add OpperApi HTTP client (v3)"
```

---

## Task 2: Resolve API context helper

**Files:**
- Create: `src/api/resolve.ts`
- Create: `test/api/resolve.test.ts`

- [ ] **Step 1: Write `test/api/resolve.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";
import { resolveApiContext } from "../../src/api/resolve.js";

useTempOpperHome();

describe("resolveApiContext", () => {
  let prevKey: string | undefined;
  let prevBase: string | undefined;
  beforeEach(() => {
    prevKey = process.env.OPPER_API_KEY;
    prevBase = process.env.OPPER_BASE_URL;
    delete process.env.OPPER_API_KEY;
    delete process.env.OPPER_BASE_URL;
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.OPPER_API_KEY;
    else process.env.OPPER_API_KEY = prevKey;
    if (prevBase === undefined) delete process.env.OPPER_BASE_URL;
    else process.env.OPPER_BASE_URL = prevBase;
  });

  it("uses the stored slot when available", async () => {
    await setSlot("default", { apiKey: "op_live_slot", baseUrl: "https://slot.example" });
    const ctx = await resolveApiContext("default");
    expect(ctx).toEqual({ apiKey: "op_live_slot", baseUrl: "https://slot.example" });
  });

  it("defaults baseUrl to https://api.opper.ai when the slot omits it", async () => {
    await setSlot("default", { apiKey: "op_live_x" });
    const ctx = await resolveApiContext("default");
    expect(ctx.baseUrl).toBe("https://api.opper.ai");
  });

  it("OPPER_API_KEY overrides the slot's apiKey", async () => {
    await setSlot("default", { apiKey: "op_live_slot" });
    process.env.OPPER_API_KEY = "op_live_env";
    const ctx = await resolveApiContext("default");
    expect(ctx.apiKey).toBe("op_live_env");
  });

  it("OPPER_BASE_URL overrides the slot's baseUrl", async () => {
    await setSlot("default", { apiKey: "k", baseUrl: "https://slot" });
    process.env.OPPER_BASE_URL = "https://env";
    const ctx = await resolveApiContext("default");
    expect(ctx.baseUrl).toBe("https://env");
  });

  it("works with only env vars (no slot)", async () => {
    process.env.OPPER_API_KEY = "op_live_envonly";
    const ctx = await resolveApiContext("default");
    expect(ctx).toEqual({ apiKey: "op_live_envonly", baseUrl: "https://api.opper.ai" });
  });

  it("throws AUTH_REQUIRED when no slot and no env var", async () => {
    await expect(resolveApiContext("default")).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- api/resolve`
Expected: FAIL.

- [ ] **Step 3: Write `src/api/resolve.ts`**

```ts
import { getSlot } from "../auth/config.js";
import { OpperError } from "../errors.js";

const DEFAULT_BASE_URL = "https://api.opper.ai";

export interface ApiContext {
  apiKey: string;
  baseUrl: string;
}

export async function resolveApiContext(keyName: string): Promise<ApiContext> {
  const slot = await getSlot(keyName);
  const apiKey = process.env.OPPER_API_KEY ?? slot?.apiKey;
  const baseUrl =
    process.env.OPPER_BASE_URL ?? slot?.baseUrl ?? DEFAULT_BASE_URL;

  if (!apiKey) {
    throw new OpperError(
      "AUTH_REQUIRED",
      `No API key for slot "${keyName}"`,
      "Run `opper login`, or set OPPER_API_KEY in the environment.",
    );
  }
  return { apiKey, baseUrl };
}
```

- [ ] **Step 4: Run — must pass**

Run: `npm test -- api/resolve`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api/resolve.ts test/api/resolve.test.ts
git commit -m "feat: add resolveApiContext with env overrides"
```

---

## Task 3: Table printer

**Files:**
- Create: `src/ui/table.ts`
- Create: `test/ui/table.test.ts`

- [ ] **Step 1: Write `test/ui/table.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { printTable } from "../../src/ui/table.js";

describe("printTable", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prev;
  });

  it("prints header + rows aligned to the widest column", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      printTable(
        ["NAME", "SCORE"],
        [
          ["alpha", "12"],
          ["beta", "3"],
        ],
      );
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines[0]).toMatch(/NAME\s+SCORE/);
      expect(lines[1]).toMatch(/alpha\s+12/);
      expect(lines[2]).toMatch(/beta\s+3/);
    } finally {
      log.mockRestore();
    }
  });

  it("prints '(no results)' when rows is empty", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      printTable(["A"], []);
      expect(log).toHaveBeenCalledWith("(no results)");
    } finally {
      log.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- ui/table`
Expected: FAIL.

- [ ] **Step 3: Write `src/ui/table.ts`**

```ts
import { brand } from "./colors.js";

export function printTable(headers: string[], rows: string[][]): void {
  if (rows.length === 0) {
    console.log("(no results)");
    return;
  }
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  console.log(brand.bold(fmt(headers)));
  for (const row of rows) {
    console.log(fmt(row));
  }
}
```

- [ ] **Step 4: Run — must pass**

Run: `npm test -- ui/table`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/table.ts test/ui/table.test.ts
git commit -m "feat: add printTable helper"
```

---

## Task 4: `opper call` (non-streaming)

**Files:**
- Create: `src/commands/call.ts`
- Create: `test/commands/call.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write `test/commands/call.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const postMock = vi.fn();
vi.mock("../../src/api/client.js", () => ({
  OpperApi: vi.fn().mockImplementation(() => ({
    post: postMock,
    stream: vi.fn(),
  })),
}));

const { callCommand } = await import("../../src/commands/call.js");

useTempOpperHome();

describe("callCommand", () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it("posts to /v3/call with name, instructions, input", async () => {
    await setSlot("default", { apiKey: "op_live_x" });
    postMock.mockResolvedValue({
      data: "hello world",
      meta: { function_name: "greet" },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await callCommand({
        name: "greet",
        instructions: "say hi",
        input: "world",
        key: "default",
      });
      expect(postMock).toHaveBeenCalledWith(
        "/v3/call",
        expect.objectContaining({
          name: "greet",
          instructions: "say hi",
          input: "world",
        }),
      );
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("hello world");
    } finally {
      log.mockRestore();
    }
  });

  it("passes --model through", async () => {
    await setSlot("default", { apiKey: "k" });
    postMock.mockResolvedValue({ data: "x" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await callCommand({
        name: "f",
        instructions: "i",
        input: "in",
        key: "default",
        model: "anthropic/claude-opus-4.7",
      });
      expect(postMock).toHaveBeenCalledWith(
        "/v3/call",
        expect.objectContaining({ model: "anthropic/claude-opus-4.7" }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it("pretty-prints object data as JSON", async () => {
    await setSlot("default", { apiKey: "k" });
    postMock.mockResolvedValue({ data: { score: 0.99, tag: "ok" } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await callCommand({ name: "f", instructions: "i", input: "x", key: "default" });
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("\"score\": 0.99");
      expect(out).toContain("\"tag\": \"ok\"");
    } finally {
      log.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- commands/call`
Expected: FAIL.

- [ ] **Step 3: Write `src/commands/call.ts`**

```ts
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
```

- [ ] **Step 4: Wire into `src/index.ts`** (additive). Import:

```ts
import { callCommand } from "./commands/call.js";
```

Before `program.parseAsync(...)`:

```ts
program
  .command("call")
  .description("Execute a function by name via the Opper v3 /call endpoint")
  .argument("<name>", "function name")
  .argument("<instructions>", "instructions / system prompt")
  .argument("[input]", "input (or piped via stdin)")
  .option("--model <id>", "model identifier (e.g. anthropic/claude-opus-4.7)")
  .action(async (
    name: string,
    instructions: string,
    input: string | undefined,
    cmdOpts: { model?: string },
  ) => {
    const resolvedInput = input ?? (await readStdinIfPiped());
    if (!resolvedInput) {
      throw new Error("No input provided. Pass as a positional arg or pipe via stdin.");
    }
    await callCommand({
      name,
      instructions,
      input: resolvedInput,
      key: program.opts().key,
      ...(cmdOpts.model ? { model: cmdOpts.model } : {}),
    });
  });
```

Add this helper near the top of `src/index.ts` (once):

```ts
async function readStdinIfPiped(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}
```

- [ ] **Step 5: Run — must pass**

Run: `npm test -- commands/call`
Expected: PASS (3 tests). Full suite passing. typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/commands/call.ts src/index.ts test/commands/call.test.ts
git commit -m "feat: add \`opper call\` command"
```

---

## Task 5: `opper call --stream`

**Files:**
- Modify: `src/commands/call.ts`
- Modify: `test/commands/call.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Append a test to `test/commands/call.test.ts`**

```ts
it("streams when --stream is passed and writes deltas to stdout", async () => {
  await setSlot("default", { apiKey: "k" });
  const streamMock = vi.fn(async function* () {
    yield JSON.stringify({ delta: "hel" });
    yield JSON.stringify({ delta: "lo" });
  });
  const { OpperApi } = await import("../../src/api/client.js");
  vi.mocked(OpperApi).mockImplementation(
    () => ({ post: postMock, stream: streamMock }) as unknown as InstanceType<typeof OpperApi>,
  );

  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await callCommand({
      name: "f",
      instructions: "i",
      input: "x",
      key: "default",
      stream: true,
    });
    const written = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("hel");
    expect(written).toContain("lo");
    expect(streamMock).toHaveBeenCalledWith(
      "/v3/call/stream",
      expect.objectContaining({ stream: true }),
    );
  } finally {
    writeSpy.mockRestore();
  }
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- commands/call`
Expected: FAIL (stream not implemented, new test fails).

- [ ] **Step 3: Update `src/commands/call.ts`**

Add `stream?: boolean` to `CallOptions` and branch:

```ts
export interface CallOptions {
  name: string;
  instructions: string;
  input: string;
  key: string;
  model?: string;
  stream?: boolean;
}

// …

export async function callCommand(opts: CallOptions): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);

  const body: Record<string, unknown> = {
    name: opts.name,
    instructions: opts.instructions,
    input: opts.input,
    stream: !!opts.stream,
  };
  if (opts.model) body.model = opts.model;

  if (opts.stream) {
    for await (const payload of api.stream("/v3/call/stream", body)) {
      try {
        const parsed = JSON.parse(payload) as { delta?: string };
        if (parsed.delta) process.stdout.write(parsed.delta);
      } catch {
        process.stdout.write(payload);
      }
    }
    process.stdout.write("\n");
    return;
  }

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
```

- [ ] **Step 4: Wire `--stream` flag in `src/index.ts`** — add to the `call` command's options:

```ts
  .option("--stream", "stream the response token-by-token", false)
```

And pass to `callCommand`:

```ts
      ...(cmdOpts.stream ? { stream: true } : {}),
```

Update the action typing to include `stream?: boolean`.

- [ ] **Step 5: Run — must pass**

Run: `npm test -- commands/call`
Expected: PASS (4 tests). typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/commands/call.ts src/index.ts test/commands/call.test.ts
git commit -m "feat: add --stream to \`opper call\`"
```

---

## Task 6: `opper models list`

**Files:**
- Create: `src/commands/models.ts`
- Create: `test/commands/models.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write `test/commands/models.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const getMock = vi.fn();
vi.mock("../../src/api/client.js", () => ({
  OpperApi: vi.fn().mockImplementation(() => ({ get: getMock })),
}));

const { modelsListCommand } = await import("../../src/commands/models.js");

useTempOpperHome();

describe("modelsListCommand", () => {
  it("prints a table of model name, id, context_window", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({
      models: [
        { name: "Claude Opus 4.7", id: "anthropic/claude-opus-4.7", context_window: 200000 },
        { name: "GPT-4o", id: "openai/gpt-4o", context_window: 128000 },
      ],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await modelsListCommand({ key: "default" });
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("anthropic/claude-opus-4.7");
      expect(out).toContain("openai/gpt-4o");
      expect(getMock).toHaveBeenCalledWith("/v3/models");
    } finally {
      log.mockRestore();
    }
  });

  it("filters by substring match on name or id", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({
      models: [
        { name: "Claude Opus", id: "anthropic/claude-opus-4.7", context_window: 1 },
        { name: "GPT-4o", id: "openai/gpt-4o", context_window: 1 },
      ],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await modelsListCommand({ key: "default", filter: "claude" });
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("anthropic/claude-opus-4.7");
      expect(out).not.toContain("openai/gpt-4o");
    } finally {
      log.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- commands/models`
Expected: FAIL.

- [ ] **Step 3: Write `src/commands/models.ts`**

```ts
import { OpperApi } from "../api/client.js";
import { resolveApiContext } from "../api/resolve.js";
import { printTable } from "../ui/table.js";

export interface ModelsListOptions {
  key: string;
  filter?: string;
}

interface ModelsResponse {
  models: Array<{
    id: string;
    name?: string;
    context_window?: number;
  }>;
}

export async function modelsListCommand(opts: ModelsListOptions): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const resp = await api.get<ModelsResponse>("/v3/models");
  const filter = opts.filter?.toLowerCase();
  const rows = resp.models
    .filter((m) =>
      filter
        ? (m.name ?? "").toLowerCase().includes(filter) ||
          m.id.toLowerCase().includes(filter)
        : true,
    )
    .map((m) => [
      m.name ?? "",
      m.id,
      m.context_window ? m.context_window.toString() : "",
    ]);
  printTable(["NAME", "ID", "CONTEXT"], rows);
}
```

- [ ] **Step 4: Wire into `src/index.ts`**:

```ts
import { modelsListCommand } from "./commands/models.js";

const modelsCmd = program
  .command("models")
  .description("Manage models");

modelsCmd
  .command("list")
  .description("List available models")
  .argument("[filter]", "optional substring filter on name or id")
  .action(async (filter: string | undefined) => {
    await modelsListCommand({
      key: program.opts().key,
      ...(filter ? { filter } : {}),
    });
  });
```

- [ ] **Step 5: Run — must pass**

Run: `npm test -- commands/models`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/commands/models.ts src/index.ts test/commands/models.test.ts
git commit -m "feat: add \`opper models list\` command"
```

---

## Task 7: `opper functions list`

**Files:**
- Create: `src/commands/functions.ts`
- Create: `test/commands/functions.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write `test/commands/functions.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const getMock = vi.fn();
const delMock = vi.fn();
vi.mock("../../src/api/client.js", () => ({
  OpperApi: vi.fn().mockImplementation(() => ({ get: getMock, del: delMock })),
}));

const {
  functionsListCommand,
  functionsGetCommand,
  functionsDeleteCommand,
} = await import("../../src/commands/functions.js");

useTempOpperHome();

describe("functions commands", () => {
  beforeEach(() => {
    getMock.mockReset();
    delMock.mockReset();
  });

  it("list prints a table of function names", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({
      functions: [
        { name: "greet", description: "say hi" },
        { name: "summarize", description: "summarize text" },
      ],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await functionsListCommand({ key: "default" });
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("greet");
      expect(out).toContain("summarize");
      expect(getMock).toHaveBeenCalledWith("/v3/functions");
    } finally {
      log.mockRestore();
    }
  });

  it("get prints function details", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({
      name: "greet",
      description: "say hi",
      instructions: "respond in kind",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await functionsGetCommand({ name: "greet", key: "default" });
      expect(getMock).toHaveBeenCalledWith("/v3/functions/greet");
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("greet");
      expect(out).toContain("respond in kind");
    } finally {
      log.mockRestore();
    }
  });

  it("delete calls DELETE /v3/functions/{name}", async () => {
    await setSlot("default", { apiKey: "k" });
    delMock.mockResolvedValue(undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await functionsDeleteCommand({ name: "greet", key: "default" });
      expect(delMock).toHaveBeenCalledWith("/v3/functions/greet");
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("Deleted");
    } finally {
      log.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- commands/functions`
Expected: FAIL.

- [ ] **Step 3: Write `src/commands/functions.ts`**

```ts
import { OpperApi } from "../api/client.js";
import { resolveApiContext } from "../api/resolve.js";
import { brand } from "../ui/colors.js";
import { printTable } from "../ui/table.js";

export interface FunctionsListOptions {
  key: string;
  filter?: string;
}

export interface FunctionsGetOptions {
  name: string;
  key: string;
}

export interface FunctionsDeleteOptions {
  name: string;
  key: string;
}

interface FunctionInfo {
  name: string;
  description?: string;
  instructions?: string;
  created_at?: string;
}

interface ListResponse {
  functions: FunctionInfo[];
}

export async function functionsListCommand(
  opts: FunctionsListOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const resp = await api.get<ListResponse>("/v3/functions");
  const filter = opts.filter?.toLowerCase();
  const rows = resp.functions
    .filter((f) =>
      filter ? f.name.toLowerCase().includes(filter) : true,
    )
    .map((f) => [f.name, f.description ?? ""]);
  printTable(["NAME", "DESCRIPTION"], rows);
}

export async function functionsGetCommand(
  opts: FunctionsGetOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const fn = await api.get<FunctionInfo>(
    `/v3/functions/${encodeURIComponent(opts.name)}`,
  );
  console.log(`${brand.bold("name:")}         ${fn.name}`);
  if (fn.description) {
    console.log(`${brand.bold("description:")}  ${fn.description}`);
  }
  if (fn.instructions) {
    console.log(`${brand.bold("instructions:")} ${fn.instructions}`);
  }
  if (fn.created_at) {
    console.log(`${brand.bold("created:")}      ${fn.created_at}`);
  }
}

export async function functionsDeleteCommand(
  opts: FunctionsDeleteOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  await api.del(`/v3/functions/${encodeURIComponent(opts.name)}`);
  console.log(brand.purple(`✓ Deleted function "${opts.name}".`));
}
```

- [ ] **Step 4: Wire into `src/index.ts`**

```ts
import {
  functionsListCommand,
  functionsGetCommand,
  functionsDeleteCommand,
} from "./commands/functions.js";

const functionsCmd = program
  .command("functions")
  .description("Manage Opper functions");

functionsCmd
  .command("list")
  .description("List functions")
  .argument("[filter]", "optional substring filter on name")
  .action(async (filter: string | undefined) => {
    await functionsListCommand({
      key: program.opts().key,
      ...(filter ? { filter } : {}),
    });
  });

functionsCmd
  .command("get")
  .description("Show details of a function")
  .argument("<name>", "function name")
  .action(async (name: string) => {
    await functionsGetCommand({ name, key: program.opts().key });
  });

functionsCmd
  .command("delete")
  .description("Delete a function")
  .argument("<name>", "function name")
  .action(async (name: string) => {
    await functionsDeleteCommand({ name, key: program.opts().key });
  });
```

- [ ] **Step 5: Run — must pass**

Run: `npm test -- commands/functions`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/commands/functions.ts src/index.ts test/commands/functions.test.ts
git commit -m "feat: add \`opper functions list/get/delete\` commands"
```

---

## Task 8: `opper traces list/get/delete`

**Files:**
- Create: `src/commands/traces.ts`
- Create: `test/commands/traces.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write `test/commands/traces.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const getMock = vi.fn();
const delMock = vi.fn();
vi.mock("../../src/api/client.js", () => ({
  OpperApi: vi.fn().mockImplementation(() => ({ get: getMock, del: delMock })),
}));

const {
  tracesListCommand,
  tracesGetCommand,
  tracesDeleteCommand,
} = await import("../../src/commands/traces.js");

useTempOpperHome();

describe("traces commands", () => {
  beforeEach(() => {
    getMock.mockReset();
    delMock.mockReset();
  });

  it("list calls GET /v3/traces and prints a table", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({
      traces: [
        { uuid: "t1", name: "call-foo", status: "ok", start_time: "2026-04-21T00:00:00Z", duration_ms: 42 },
        { uuid: "t2", name: "call-bar", status: "error", start_time: "2026-04-21T00:01:00Z", duration_ms: 1200 },
      ],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await tracesListCommand({ key: "default" });
      expect(getMock).toHaveBeenCalledWith("/v3/traces", expect.any(Object));
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("t1");
      expect(out).toContain("call-bar");
    } finally {
      log.mockRestore();
    }
  });

  it("list forwards --limit and --name", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({ traces: [] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await tracesListCommand({ key: "default", limit: 50, name: "foo" });
      expect(getMock).toHaveBeenCalledWith(
        "/v3/traces",
        expect.objectContaining({ limit: 50, name: "foo" }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it("get prints trace details", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({
      trace: { uuid: "t1", name: "call", status: "ok" },
      spans: [{ uuid: "s1", name: "root" }],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await tracesGetCommand({ id: "t1", key: "default" });
      expect(getMock).toHaveBeenCalledWith("/v3/traces/t1");
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("t1");
    } finally {
      log.mockRestore();
    }
  });

  it("delete calls DELETE /v3/traces/{id}", async () => {
    await setSlot("default", { apiKey: "k" });
    delMock.mockResolvedValue(undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await tracesDeleteCommand({ id: "t1", key: "default" });
      expect(delMock).toHaveBeenCalledWith("/v3/traces/t1");
    } finally {
      log.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- commands/traces`
Expected: FAIL.

- [ ] **Step 3: Write `src/commands/traces.ts`**

```ts
import { OpperApi } from "../api/client.js";
import { resolveApiContext } from "../api/resolve.js";
import { brand } from "../ui/colors.js";
import { printTable } from "../ui/table.js";

export interface TracesListOptions {
  key: string;
  limit?: number;
  offset?: number;
  name?: string;
}

export interface TracesGetOptions {
  id: string;
  key: string;
}

export interface TracesDeleteOptions {
  id: string;
  key: string;
}

interface TraceSummary {
  uuid: string;
  name?: string;
  status?: string;
  start_time?: string;
  duration_ms?: number;
}

interface ListResponse {
  traces: TraceSummary[];
}

interface GetResponse {
  trace: TraceSummary & { [k: string]: unknown };
  spans?: Array<Record<string, unknown>>;
}

export async function tracesListCommand(
  opts: TracesListOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const query: Record<string, string | number | undefined> = {};
  if (opts.limit !== undefined) query.limit = opts.limit;
  if (opts.offset !== undefined) query.offset = opts.offset;
  if (opts.name !== undefined) query.name = opts.name;

  const resp = await api.get<ListResponse>("/v3/traces", query);
  const rows = resp.traces.map((t) => [
    t.uuid,
    t.name ?? "",
    t.status ?? "",
    t.start_time ?? "",
    t.duration_ms ? `${t.duration_ms}ms` : "",
  ]);
  printTable(["UUID", "NAME", "STATUS", "START", "DURATION"], rows);
}

export async function tracesGetCommand(
  opts: TracesGetOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const resp = await api.get<GetResponse>(
    `/v3/traces/${encodeURIComponent(opts.id)}`,
  );
  const t = resp.trace;
  console.log(`${brand.bold("uuid:")}     ${t.uuid}`);
  if (t.name) console.log(`${brand.bold("name:")}     ${t.name}`);
  if (t.status) console.log(`${brand.bold("status:")}   ${t.status}`);
  if (t.start_time) console.log(`${brand.bold("start:")}    ${t.start_time}`);
  if (t.duration_ms !== undefined) {
    console.log(`${brand.bold("duration:")} ${t.duration_ms}ms`);
  }
  if (resp.spans?.length) {
    console.log(`${brand.bold("spans:")}    ${resp.spans.length}`);
  }
}

export async function tracesDeleteCommand(
  opts: TracesDeleteOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  await api.del(`/v3/traces/${encodeURIComponent(opts.id)}`);
  console.log(brand.purple(`✓ Deleted trace "${opts.id}".`));
}
```

- [ ] **Step 4: Wire into `src/index.ts`**

```ts
import {
  tracesListCommand,
  tracesGetCommand,
  tracesDeleteCommand,
} from "./commands/traces.js";

const tracesCmd = program
  .command("traces")
  .description("View and manage traces");

tracesCmd
  .command("list")
  .description("List traces")
  .option("--limit <n>", "max items to return", (v) => parseInt(v, 10))
  .option("--offset <n>", "items to skip", (v) => parseInt(v, 10))
  .option("--name <substring>", "filter by trace name substring")
  .action(async (cmdOpts: { limit?: number; offset?: number; name?: string }) => {
    await tracesListCommand({
      key: program.opts().key,
      ...(cmdOpts.limit !== undefined ? { limit: cmdOpts.limit } : {}),
      ...(cmdOpts.offset !== undefined ? { offset: cmdOpts.offset } : {}),
      ...(cmdOpts.name ? { name: cmdOpts.name } : {}),
    });
  });

tracesCmd
  .command("get")
  .description("Show a trace and its spans")
  .argument("<id>", "trace id")
  .action(async (id: string) => {
    await tracesGetCommand({ id, key: program.opts().key });
  });

tracesCmd
  .command("delete")
  .description("Delete a trace")
  .argument("<id>", "trace id")
  .action(async (id: string) => {
    await tracesDeleteCommand({ id, key: program.opts().key });
  });
```

- [ ] **Step 5: Run — must pass**

Run: `npm test -- commands/traces`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/commands/traces.ts src/index.ts test/commands/traces.test.ts
git commit -m "feat: add \`opper traces list/get/delete\` commands"
```

---

## Task 9: `opper config` subcommands

**Files:**
- Create: `src/commands/config.ts`
- Create: `test/commands/config.test.ts`
- Modify: `src/index.ts`

Local-only. Manages `~/.opper/config.json` slots directly — useful for CI / automation that wants to set a slot without the interactive device flow.

- [ ] **Step 1: Write `test/commands/config.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { readConfig, setSlot } from "../../src/auth/config.js";
import {
  configAddCommand,
  configListCommand,
  configGetCommand,
  configRemoveCommand,
} from "../../src/commands/config.js";

useTempOpperHome();

describe("config commands", () => {
  it("add stores a slot", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await configAddCommand({
        name: "staging",
        apiKey: "op_live_stg",
      });
      const cfg = await readConfig();
      expect(cfg?.keys.staging?.apiKey).toBe("op_live_stg");
      expect(cfg?.keys.staging?.source).toBe("manual");
    } finally {
      log.mockRestore();
    }
  });

  it("add accepts --base-url", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await configAddCommand({
        name: "staging",
        apiKey: "op_live_stg",
        baseUrl: "https://staging.example",
      });
      const cfg = await readConfig();
      expect(cfg?.keys.staging?.baseUrl).toBe("https://staging.example");
    } finally {
      log.mockRestore();
    }
  });

  it("list prints one line per slot with masked keys", async () => {
    await setSlot("default", { apiKey: "op_live_abc123def456" });
    await setSlot("staging", { apiKey: "op_live_stagingKey9999" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await configListCommand();
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("default");
      expect(out).toContain("staging");
      expect(out).not.toContain("op_live_abc123def456"); // full key not printed
    } finally {
      log.mockRestore();
    }
  });

  it("get prints the raw key (for scripts)", async () => {
    await setSlot("default", { apiKey: "op_live_raw" });
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await configGetCommand({ name: "default" });
      const written = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(written.trim()).toBe("op_live_raw");
    } finally {
      spy.mockRestore();
    }
  });

  it("get throws AUTH_REQUIRED when slot missing", async () => {
    await expect(configGetCommand({ name: "missing" })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });

  it("remove deletes the slot", async () => {
    await setSlot("default", { apiKey: "k1" });
    await setSlot("staging", { apiKey: "k2" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await configRemoveCommand({ name: "staging" });
      const cfg = await readConfig();
      expect(cfg?.keys.staging).toBeUndefined();
      expect(cfg?.keys.default).toBeDefined();
    } finally {
      log.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- commands/config`
Expected: FAIL.

- [ ] **Step 3: Write `src/commands/config.ts`**

```ts
import {
  setSlot,
  getSlot,
  deleteSlot,
  readConfig,
} from "../auth/config.js";
import { OpperError } from "../errors.js";
import { brand } from "../ui/colors.js";

export interface ConfigAddOptions {
  name: string;
  apiKey: string;
  baseUrl?: string;
}

export interface ConfigGetOptions {
  name: string;
}

export interface ConfigRemoveOptions {
  name: string;
}

function fingerprint(key: string): string {
  if (key.length <= 10) return "********";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export async function configAddCommand(opts: ConfigAddOptions): Promise<void> {
  await setSlot(opts.name, {
    apiKey: opts.apiKey,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    source: "manual",
    obtainedAt: new Date().toISOString(),
  });
  console.log(brand.purple(`✓ Stored API key for slot "${opts.name}".`));
}

export async function configListCommand(): Promise<void> {
  const cfg = await readConfig();
  if (!cfg || Object.keys(cfg.keys).length === 0) {
    console.log("(no slots configured)");
    return;
  }
  for (const [name, slot] of Object.entries(cfg.keys)) {
    const marker = name === cfg.defaultKey ? brand.purple("*") : " ";
    console.log(`${marker} ${name.padEnd(14)} ${fingerprint(slot.apiKey)}`);
  }
}

export async function configGetCommand(opts: ConfigGetOptions): Promise<void> {
  const slot = await getSlot(opts.name);
  if (!slot) {
    throw new OpperError(
      "AUTH_REQUIRED",
      `No slot named "${opts.name}"`,
      "Run `opper config add <name> <api-key>` or `opper login --key <name>`.",
    );
  }
  // Raw key, no newline — easier to pipe into other tools.
  process.stdout.write(`${slot.apiKey}\n`);
}

export async function configRemoveCommand(
  opts: ConfigRemoveOptions,
): Promise<void> {
  await deleteSlot(opts.name);
  console.log(brand.purple(`✓ Removed slot "${opts.name}".`));
}
```

- [ ] **Step 4: Wire into `src/index.ts`**

```ts
import {
  configAddCommand,
  configListCommand,
  configGetCommand,
  configRemoveCommand,
} from "./commands/config.js";

const configCmd = program
  .command("config")
  .description("Manage stored API keys");

configCmd
  .command("add")
  .description("Manually store an API key for a slot")
  .argument("<name>", "slot name")
  .argument("<apiKey>", "Opper API key")
  .option("--base-url <url>", "custom Opper base URL for this slot")
  .action(async (
    name: string,
    apiKey: string,
    cmdOpts: { baseUrl?: string },
  ) => {
    await configAddCommand({
      name,
      apiKey,
      ...(cmdOpts.baseUrl ? { baseUrl: cmdOpts.baseUrl } : {}),
    });
  });

configCmd
  .command("list")
  .description("List configured slots")
  .action(configListCommand);

configCmd
  .command("get")
  .description("Print the API key for a slot (raw, for scripts)")
  .argument("<name>", "slot name")
  .action(async (name: string) => {
    await configGetCommand({ name });
  });

configCmd
  .command("remove")
  .description("Delete a stored slot")
  .argument("<name>", "slot name")
  .action(async (name: string) => {
    await configRemoveCommand({ name });
  });
```

- [ ] **Step 5: Run — must pass**

Run: `npm test -- commands/config`
Expected: PASS (6 tests). typecheck exit 0. Full suite passing.

- [ ] **Step 6: Commit**

```bash
git add src/commands/config.ts src/index.ts test/commands/config.test.ts
git commit -m "feat: add \`opper config\` subcommands"
```

---

## Task 10: README + final smoke + push

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Expand README "Commands" section**

Replace the existing Commands section with:

```markdown
## Commands

### Auth
- `opper login` — Authenticate via the OAuth device flow.
- `opper logout` — Clear stored credentials.
- `opper whoami` — Show the authenticated user for the active slot.
- `opper config add <name> <api-key> [--base-url <url>]` — Manually store an API key.
- `opper config list` — List configured slots.
- `opper config get <name>` — Print the raw API key for scripting.
- `opper config remove <name>` — Delete a stored slot.

### Platform
- `opper call <name> <instructions> [input] [--model <id>] [--stream]` — Execute a function via the v3 /call endpoint. Reads input from stdin if the positional arg is omitted.
- `opper models list [filter]` — List available models.
- `opper functions list [filter]` — List cached functions.
- `opper functions get <name>` — Show details of a function.
- `opper functions delete <name>` — Delete a cached function.
- `opper traces list [--limit <n>] [--offset <n>] [--name <substring>]` — List traces.
- `opper traces get <id>` — Show a trace and its spans.
- `opper traces delete <id>` — Delete a trace.

### Skills
- `opper skills install` — Install the Opper skill pack via `npx skills`.
- `opper skills update` — Update the installed skills.
- `opper skills list` — Show whether Opper skills are installed.

### Editor integrations
- `opper editors list` — List supported editors and which can be auto-configured.
- `opper editors opencode [--global|--local] [--overwrite]` — Write the Opper provider into OpenCode's config.
- `opper editors continue [--global|--local] [--overwrite]` — Write Opper models into Continue.dev's config.

### Agents
- `opper agents list` — List supported AI agents and whether each is installed.
- `opper launch <agent> [--model <id>] [--install] [-- <agent args>]` — Launch a supported agent with its inference routed through Opper.

### Wizards
- `opper setup` — Interactive wizard.

### Misc
- `opper version` — Print the CLI version.
```

- [ ] **Step 2: Run full verification**

```bash
cd /Users/joch/dev/opper-ai/cli
npm test
npm run typecheck
npm run build
```

All must pass.

- [ ] **Step 3: Smoke test**

```bash
export OPPER_HOME=$(mktemp -d)
node dist/index.js --help
node dist/index.js models list 2>&1 || echo "exit=$?"
# Expected: AUTH_REQUIRED exit 2 (no slot stored in the temp home)
node dist/index.js config add default op_live_fake
node dist/index.js config list
node dist/index.js config remove default
unset OPPER_HOME
```

Paste the output in the report.

- [ ] **Step 4: Commit + push**

```bash
git add README.md
git commit -m "docs: document platform commands (call/models/functions/traces/config)"
git push -u origin feat/plan-4-platform-commands
```

## Report

- Status
- Full test count
- Smoke output
- Commit SHA
- Push outcome
