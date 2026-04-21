# Plan 5 — v2 Fallback Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the commands that were deferred in Plan 4 because v3 didn't expose equivalent endpoints. Implement them against the v2 API where endpoints exist: `opper indexes *` (v2 `/knowledge/*`), `opper models create/get/delete` (v2 `/models/custom/*`), `opper usage list` (v2 `/analytics/usage`), and `opper image generate` (convenience wrapper over v3 `/call`).

**Architecture:** Reuse the `OpperApi` client from Plan 4. v2 and v3 share the host (`https://api.opper.ai`); paths just change prefix. A new `patch` method is added to the client for custom-model updates. All commands follow the established pattern: exported `xxxCommand(opts)` + wire into `src/index.ts`.

**Tech Stack:** Inherited. No new deps.

**Depends on:** Plans 1-4. Specifically `OpperApi`, `resolveApiContext`, `printTable`, `brand`, `OpperError`, `callCommand` (image generation wraps it).

**v2 API reference:** `https://api.opper.ai/v2/openapi.json` — downloaded during plan design. Path prefix: append `/v2/<path>` to base URL.

**Key v3↔v2 mappings:**
- `indexes` command → v2 `/knowledge` resource (renamed from "indexes" to "knowledge")
- `models create/delete/get` → v2 `/models/custom/*`
- `usage` → v2 `/analytics/usage`

---

## Scope decisions

- **Index/knowledge naming**: keep the CLI command name as `opper indexes` (matches Go CLI ergonomics) but call v2 `/knowledge/*` under the hood. Users don't need to know the server-side rename.
- **Delete-by-name**: v2's `DELETE /knowledge/{id}` and `DELETE /models/custom/{id}` only accept IDs. Our CLI accepts the user-facing name, does a `GET /…/by-name/{name}` lookup first, then deletes by ID. One extra round-trip — acceptable for interactive use.
- **Usage output**: the Go CLI supported table / CSV / ASCII graph outputs. v1 of Plan 5 ships table + CSV. ASCII graph is a phase-5.5 nice-to-have (defer).
- **Image generate**: no dedicated `/v2/image` or `/v3/image` endpoint. The Go CLI hit `/v1/call` with an image-generation model. We replicate by calling `v3/call` with the same model and writing the returned bytes to a file (or base64 to stdout with `--base64`).
- **Functions evaluations**: v2 `/functions/{id}/*` has `save_examples`, `feedback`, `metrics`, `datasets`, and `config` sub-resources, but no `evaluations`. Truly deferred.
- **`indexes upload`** (file-upload flow via pre-signed URL — 2 API calls): deferred. Users can use `add` for small text content; file upload via the web UI for now. Flag as a follow-up.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/api/client.ts` | + `patch<T>(path, body)` method |
| `src/commands/indexes.ts` | `opper indexes list/get/create/delete/query/add` |
| `src/commands/models.ts` | + `modelsCreateCommand`, `modelsGetCommand`, `modelsDeleteCommand` |
| `src/commands/usage.ts` | `opper usage list` |
| `src/commands/image.ts` | `opper image generate` |
| `test/api/client.test.ts` | + patch test |
| `test/commands/indexes.test.ts` | |
| `test/commands/models.test.ts` | + tests for create/get/delete |
| `test/commands/usage.test.ts` | |
| `test/commands/image.test.ts` | |
| `src/index.ts` | + new command wiring |
| `README.md` | Document the new commands |

Total: 10 tasks.

---

## Task 1: Add `patch` to OpperApi

**Files:**
- Modify: `src/api/client.ts`
- Modify: `test/api/client.test.ts`

- [ ] **Step 1: Append a test** inside the existing `describe("OpperApi", …)` block:

```ts
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
```

- [ ] **Step 2: Run — expect failure**

Run: `cd /Users/joch/dev/opper-ai/cli && npm test -- api/client`
Expected: the new test FAILS with "patch is not a function" (others still pass).

- [ ] **Step 3: Add `patch` method to `src/api/client.ts`**, between `post` and `del`:

```ts
  async patch<T>(path: string, body: unknown): Promise<T> {
    const url = this.buildUrl(path);
    const res = await this.fetch(url, {
      method: "PATCH",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    return this.parseJson<T>(res);
  }
```

- [ ] **Step 4: Run — must pass**

Run: `npm test -- api/client` — all pass (9 tests now).

- [ ] **Step 5: Commit**

```bash
git add src/api/client.ts test/api/client.test.ts
git commit -m "feat: add PATCH method to OpperApi"
```

---

## Task 2: `opper indexes list` + `get`

**Files:**
- Create: `src/commands/indexes.ts`
- Create: `test/commands/indexes.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write `test/commands/indexes.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const getMock = vi.fn();
const postMock = vi.fn();
const delMock = vi.fn();
vi.mock("../../src/api/client.js", () => ({
  OpperApi: vi.fn().mockImplementation(() => ({
    get: getMock,
    post: postMock,
    del: delMock,
  })),
}));

const {
  indexesListCommand,
  indexesGetCommand,
} = await import("../../src/commands/indexes.js");

useTempOpperHome();

describe("indexes list + get", () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it("list prints a table of indexes from v2 /knowledge", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({
      meta: { total: 2 },
      data: [
        { id: "k1", name: "product-docs", embedding_model: "m", created_at: "2026-04-21T00:00:00Z" },
        { id: "k2", name: "support-kb", embedding_model: "m", created_at: "2026-04-20T00:00:00Z" },
      ],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await indexesListCommand({ key: "default" });
      expect(getMock).toHaveBeenCalledWith("/v2/knowledge", expect.any(Object));
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("product-docs");
      expect(out).toContain("support-kb");
    } finally {
      log.mockRestore();
    }
  });

  it("get prints index details", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({
      id: "k1",
      name: "product-docs",
      embedding_model: "m",
      created_at: "2026-04-21T00:00:00Z",
      count: 42,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await indexesGetCommand({ name: "product-docs", key: "default" });
      expect(getMock).toHaveBeenCalledWith("/v2/knowledge/by-name/product-docs");
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("product-docs");
      expect(out).toContain("42");
    } finally {
      log.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- commands/indexes`
Expected: FAIL "Cannot find module".

- [ ] **Step 3: Write `src/commands/indexes.ts`** (list + get only; rest comes in tasks 3-5):

```ts
import { OpperApi } from "../api/client.js";
import { resolveApiContext } from "../api/resolve.js";
import { brand } from "../ui/colors.js";
import { printTable } from "../ui/table.js";

export interface IndexesListOptions {
  key: string;
  limit?: number;
  offset?: number;
}

export interface IndexesGetOptions {
  name: string;
  key: string;
}

interface ListResponse {
  meta: { total?: number };
  data: Array<{
    id: string;
    name: string;
    embedding_model?: string;
    created_at?: string;
  }>;
}

interface GetResponse {
  id: string;
  name: string;
  embedding_model?: string;
  created_at?: string;
  count?: number;
}

export async function indexesListCommand(
  opts: IndexesListOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const query: Record<string, string | number | undefined> = {};
  if (opts.limit !== undefined) query.limit = opts.limit;
  if (opts.offset !== undefined) query.offset = opts.offset;
  const resp = await api.get<ListResponse>("/v2/knowledge", query);
  const rows = resp.data.map((k) => [
    k.name,
    k.id,
    k.embedding_model ?? "",
    k.created_at ?? "",
  ]);
  printTable(["NAME", "ID", "EMBEDDING", "CREATED"], rows);
}

export async function indexesGetCommand(
  opts: IndexesGetOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const k = await api.get<GetResponse>(
    `/v2/knowledge/by-name/${encodeURIComponent(opts.name)}`,
  );
  console.log(`${brand.bold("name:")}      ${k.name}`);
  console.log(`${brand.bold("id:")}        ${k.id}`);
  if (k.embedding_model) {
    console.log(`${brand.bold("embedding:")} ${k.embedding_model}`);
  }
  if (k.created_at) {
    console.log(`${brand.bold("created:")}   ${k.created_at}`);
  }
  if (k.count !== undefined) {
    console.log(`${brand.bold("documents:")} ${k.count}`);
  }
}
```

- [ ] **Step 4: Wire into `src/index.ts`** (additive). Import:

```ts
import { indexesListCommand, indexesGetCommand } from "./commands/indexes.js";
```

Before `program.parseAsync(...)`:

```ts
const indexesCmd = program
  .command("indexes")
  .description("Manage knowledge base indexes");

indexesCmd
  .command("list")
  .description("List indexes")
  .option("--limit <n>", "max items", (v) => parseInt(v, 10))
  .option("--offset <n>", "items to skip", (v) => parseInt(v, 10))
  .action(async (cmdOpts: { limit?: number; offset?: number }) => {
    await indexesListCommand({
      key: program.opts().key,
      ...(cmdOpts.limit !== undefined ? { limit: cmdOpts.limit } : {}),
      ...(cmdOpts.offset !== undefined ? { offset: cmdOpts.offset } : {}),
    });
  });

indexesCmd
  .command("get")
  .description("Show details of an index")
  .argument("<name>", "index name")
  .action(async (name: string) => {
    await indexesGetCommand({ name, key: program.opts().key });
  });
```

- [ ] **Step 5: Run tests**

Run: `npm test -- commands/indexes` — PASS (2). Full suite clean. typecheck + build clean.

- [ ] **Step 6: Commit**

```bash
git add src/commands/indexes.ts src/index.ts test/commands/indexes.test.ts
git commit -m "feat: add \`opper indexes list/get\` (v2 /knowledge)"
```

---

## Task 3: `opper indexes create` + `delete`

**Files:**
- Modify: `src/commands/indexes.ts` (append)
- Modify: `test/commands/indexes.test.ts` (append)
- Modify: `src/index.ts` (wire)

- [ ] **Step 1: Append tests**

```ts
describe("indexes create + delete", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    delMock.mockReset();
  });

  it("create posts to /v2/knowledge with the name", async () => {
    await setSlot("default", { apiKey: "k" });
    postMock.mockResolvedValue({
      id: "k_new",
      name: "product-docs",
      embedding_model: "opper/default",
      created_at: "2026-04-21T00:00:00Z",
    });
    const { indexesCreateCommand } = await import("../../src/commands/indexes.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await indexesCreateCommand({ name: "product-docs", key: "default" });
      expect(postMock).toHaveBeenCalledWith(
        "/v2/knowledge",
        expect.objectContaining({ name: "product-docs" }),
      );
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("product-docs");
      expect(out).toContain("k_new");
    } finally {
      log.mockRestore();
    }
  });

  it("delete looks up by name, then DELETEs by id", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({
      id: "k_abc",
      name: "product-docs",
      embedding_model: "m",
    });
    delMock.mockResolvedValue(undefined);
    const { indexesDeleteCommand } = await import("../../src/commands/indexes.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await indexesDeleteCommand({ name: "product-docs", key: "default" });
      expect(getMock).toHaveBeenCalledWith("/v2/knowledge/by-name/product-docs");
      expect(delMock).toHaveBeenCalledWith("/v2/knowledge/k_abc");
    } finally {
      log.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- commands/indexes`
Expected: `indexesCreateCommand` / `indexesDeleteCommand` are not exported yet.

- [ ] **Step 3: Append to `src/commands/indexes.ts`**

```ts
export interface IndexesCreateOptions {
  name: string;
  key: string;
  embeddingModel?: string;
}

export interface IndexesDeleteOptions {
  name: string;
  key: string;
}

export async function indexesCreateCommand(
  opts: IndexesCreateOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const body: Record<string, unknown> = { name: opts.name };
  if (opts.embeddingModel) body.embedding_model = opts.embeddingModel;
  const created = await api.post<GetResponse>("/v2/knowledge", body);
  console.log(brand.purple(`✓ Created index "${created.name}" (${created.id}).`));
}

export async function indexesDeleteCommand(
  opts: IndexesDeleteOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const kb = await api.get<GetResponse>(
    `/v2/knowledge/by-name/${encodeURIComponent(opts.name)}`,
  );
  await api.del(`/v2/knowledge/${encodeURIComponent(kb.id)}`);
  console.log(brand.purple(`✓ Deleted index "${opts.name}".`));
}
```

- [ ] **Step 4: Wire into `src/index.ts`** — add under the `indexesCmd`:

Add imports:

```ts
import {
  indexesListCommand,
  indexesGetCommand,
  indexesCreateCommand,
  indexesDeleteCommand,
} from "./commands/indexes.js";
```

(Extend the existing import — don't duplicate.)

Add subcommands:

```ts
indexesCmd
  .command("create")
  .description("Create a new index")
  .argument("<name>", "index name")
  .option("--embedding-model <id>", "override the embedding model")
  .action(async (name: string, cmdOpts: { embeddingModel?: string }) => {
    await indexesCreateCommand({
      name,
      key: program.opts().key,
      ...(cmdOpts.embeddingModel ? { embeddingModel: cmdOpts.embeddingModel } : {}),
    });
  });

indexesCmd
  .command("delete")
  .description("Delete an index by name")
  .argument("<name>", "index name")
  .action(async (name: string) => {
    await indexesDeleteCommand({ name, key: program.opts().key });
  });
```

- [ ] **Step 5: Run — must pass**

Run: `npm test -- commands/indexes` — PASS (4 total). typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/commands/indexes.ts src/index.ts test/commands/indexes.test.ts
git commit -m "feat: add \`opper indexes create/delete\`"
```

---

## Task 4: `opper indexes query`

**Files:**
- Modify: `src/commands/indexes.ts`
- Modify: `test/commands/indexes.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Append test**

```ts
describe("indexes query", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it("query looks up by name then POSTs to /v2/knowledge/{id}/query", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({ id: "k_abc", name: "docs" });
    postMock.mockResolvedValue([
      { score: 0.92, content: "The quick brown fox", key: "doc1" },
      { score: 0.81, content: "Lazy dogs sleep", key: "doc2" },
    ]);
    const { indexesQueryCommand } = await import("../../src/commands/indexes.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await indexesQueryCommand({
        name: "docs",
        query: "foxes",
        topK: 5,
        key: "default",
      });
      expect(postMock).toHaveBeenCalledWith(
        "/v2/knowledge/k_abc/query",
        expect.objectContaining({ query: "foxes", top_k: 5 }),
      );
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("0.92");
      expect(out).toContain("quick brown fox");
    } finally {
      log.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- commands/indexes`

- [ ] **Step 3: Append to `src/commands/indexes.ts`**

```ts
export interface IndexesQueryOptions {
  name: string;
  query: string;
  key: string;
  topK?: number;
  filtersJson?: string;
}

interface QueryResult {
  score?: number;
  content?: string;
  key?: string;
  metadata?: Record<string, unknown>;
}

export async function indexesQueryCommand(
  opts: IndexesQueryOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const kb = await api.get<GetResponse>(
    `/v2/knowledge/by-name/${encodeURIComponent(opts.name)}`,
  );
  const body: Record<string, unknown> = { query: opts.query };
  if (opts.topK !== undefined) body.top_k = opts.topK;
  if (opts.filtersJson) {
    try {
      body.filters = JSON.parse(opts.filtersJson) as unknown;
    } catch {
      throw new Error(`--filters must be valid JSON; got: ${opts.filtersJson}`);
    }
  }
  const results = await api.post<QueryResult[]>(
    `/v2/knowledge/${encodeURIComponent(kb.id)}/query`,
    body,
  );
  if (!Array.isArray(results) || results.length === 0) {
    console.log("(no results)");
    return;
  }
  for (const r of results) {
    const score = r.score !== undefined ? r.score.toFixed(4) : "n/a";
    console.log(`${brand.bold("score:")}   ${score}`);
    if (r.key) console.log(`${brand.bold("key:")}     ${r.key}`);
    if (r.content) console.log(`${brand.bold("content:")} ${r.content}`);
    console.log("");
  }
}
```

- [ ] **Step 4: Wire into `src/index.ts`**

Extend the import and add:

```ts
indexesCmd
  .command("query")
  .description("Query an index")
  .argument("<name>", "index name")
  .argument("<query>", "query string")
  .option("--top-k <n>", "number of results", (v) => parseInt(v, 10))
  .option("--filters <json>", "JSON-encoded filter object")
  .action(async (
    name: string,
    query: string,
    cmdOpts: { topK?: number; filters?: string },
  ) => {
    await indexesQueryCommand({
      name,
      query,
      key: program.opts().key,
      ...(cmdOpts.topK !== undefined ? { topK: cmdOpts.topK } : {}),
      ...(cmdOpts.filters ? { filtersJson: cmdOpts.filters } : {}),
    });
  });
```

Add `indexesQueryCommand` to the import list.

- [ ] **Step 5: Run — PASS (5 total).**

- [ ] **Step 6: Commit**

```bash
git add src/commands/indexes.ts src/index.ts test/commands/indexes.test.ts
git commit -m "feat: add \`opper indexes query\`"
```

---

## Task 5: `opper indexes add`

**Files:**
- Modify: `src/commands/indexes.ts`
- Modify: `test/commands/indexes.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Append test**

```ts
describe("indexes add", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it("add looks up by name then POSTs to /v2/knowledge/{id}/add", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({ id: "k_abc", name: "docs" });
    postMock.mockResolvedValue({ success: true });
    const { indexesAddCommand } = await import("../../src/commands/indexes.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await indexesAddCommand({
        name: "docs",
        docKey: "doc1",
        content: "Hello world",
        metadataJson: JSON.stringify({ lang: "en" }),
        key: "default",
      });
      expect(postMock).toHaveBeenCalledWith(
        "/v2/knowledge/k_abc/add",
        expect.objectContaining({
          key: "doc1",
          content: "Hello world",
          metadata: { lang: "en" },
        }),
      );
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out.toLowerCase()).toContain("added");
    } finally {
      log.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- commands/indexes`

- [ ] **Step 3: Append to `src/commands/indexes.ts`**

```ts
export interface IndexesAddOptions {
  name: string;
  docKey?: string;
  content: string;
  metadataJson?: string;
  key: string;
}

export async function indexesAddCommand(
  opts: IndexesAddOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const kb = await api.get<GetResponse>(
    `/v2/knowledge/by-name/${encodeURIComponent(opts.name)}`,
  );
  const body: Record<string, unknown> = { content: opts.content };
  if (opts.docKey) body.key = opts.docKey;
  if (opts.metadataJson) {
    try {
      body.metadata = JSON.parse(opts.metadataJson) as unknown;
    } catch {
      throw new Error(`--metadata must be valid JSON; got: ${opts.metadataJson}`);
    }
  }
  await api.post(`/v2/knowledge/${encodeURIComponent(kb.id)}/add`, body);
  console.log(brand.purple(`✓ Added document to "${opts.name}".`));
}
```

- [ ] **Step 4: Wire into `src/index.ts`**

```ts
indexesCmd
  .command("add")
  .description("Add a document to an index")
  .argument("<name>", "index name")
  .argument("<content>", "document content (or - to read from stdin)")
  .option("--key <id>", "document key / id")
  .option("--metadata <json>", "JSON-encoded metadata object")
  .action(async (
    name: string,
    content: string,
    cmdOpts: { key?: string; metadata?: string },
  ) => {
    let resolvedContent = content;
    if (content === "-") {
      resolvedContent = (await readStdinIfPiped()) ?? "";
      if (!resolvedContent) {
        throw new OpperError(
          "API_ERROR",
          "No content on stdin",
          "Pipe content into the CLI or pass it as a positional argument.",
        );
      }
    }
    await indexesAddCommand({
      name,
      content: resolvedContent,
      key: program.opts().key,
      ...(cmdOpts.key ? { docKey: cmdOpts.key } : {}),
      ...(cmdOpts.metadata ? { metadataJson: cmdOpts.metadata } : {}),
    });
  });
```

Add `indexesAddCommand` to the import list.

Note on `--key` shadowing the global `--key` slot option: commander's subcommand option binds locally when present, so `opper indexes add docs "hi" --key doc1` sets the document key. The active slot still comes from `program.opts().key`. If this becomes confusing, rename to `--doc-key` in a follow-up.

- [ ] **Step 5: Run — PASS (6 total).**

- [ ] **Step 6: Commit**

```bash
git add src/commands/indexes.ts src/index.ts test/commands/indexes.test.ts
git commit -m "feat: add \`opper indexes add\`"
```

---

## Task 6: `opper models create/get`

**Files:**
- Modify: `src/commands/models.ts`
- Modify: `test/commands/models.test.ts`
- Modify: `src/index.ts`

Note: v2 `/models/custom` is the endpoint for user-registered custom LLMs (Azure, self-hosted, etc.). Distinct from v3 `/models` which lists *all* built-in + custom models.

- [ ] **Step 1: Append tests** to `test/commands/models.test.ts` in a new describe block:

```ts
describe("models create + get", () => {
  it("create posts to /v2/models/custom with identifier, api_key, extra", async () => {
    await setSlot("default", { apiKey: "k" });
    const postMock = vi.fn().mockResolvedValue({
      id: "m_new",
      name: "my-gpt4",
      identifier: "azure/gpt-4o",
    });
    const { OpperApi } = await import("../../src/api/client.js");
    vi.mocked(OpperApi).mockImplementation(
      () => ({ get: getMock, post: postMock }) as unknown as InstanceType<typeof OpperApi>,
    );
    const { modelsCreateCommand } = await import("../../src/commands/models.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await modelsCreateCommand({
        name: "my-gpt4",
        identifier: "azure/gpt-4o",
        apiKey: "sk-xxx",
        extraJson: JSON.stringify({ api_base: "https://example.openai.azure.com" }),
        key: "default",
      });
      expect(postMock).toHaveBeenCalledWith(
        "/v2/models/custom",
        expect.objectContaining({
          name: "my-gpt4",
          identifier: "azure/gpt-4o",
          api_key: "sk-xxx",
          extra: { api_base: "https://example.openai.azure.com" },
        }),
      );
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("my-gpt4");
    } finally {
      log.mockRestore();
    }
  });

  it("get fetches custom model by name", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockReset();
    getMock.mockResolvedValue({
      id: "m_1",
      name: "my-gpt4",
      identifier: "azure/gpt-4o",
      type: "llm",
    });
    const { modelsGetCommand } = await import("../../src/commands/models.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await modelsGetCommand({ name: "my-gpt4", key: "default" });
      expect(getMock).toHaveBeenCalledWith("/v2/models/custom/by-name/my-gpt4");
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("azure/gpt-4o");
    } finally {
      log.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- commands/models`

- [ ] **Step 3: Append to `src/commands/models.ts`**

```ts
import { brand } from "../ui/colors.js";

export interface ModelsCreateOptions {
  name: string;
  identifier: string;
  apiKey: string;
  extraJson?: string;
  key: string;
}

export interface ModelsGetOptions {
  name: string;
  key: string;
}

interface CustomModel {
  id: string;
  name: string;
  identifier: string;
  provider?: string;
  type?: string;
  extra?: Record<string, unknown>;
}

export async function modelsCreateCommand(
  opts: ModelsCreateOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const body: Record<string, unknown> = {
    name: opts.name,
    identifier: opts.identifier,
    api_key: opts.apiKey,
  };
  if (opts.extraJson) {
    try {
      body.extra = JSON.parse(opts.extraJson) as unknown;
    } catch {
      throw new Error(`--extra must be valid JSON; got: ${opts.extraJson}`);
    }
  }
  const created = await api.post<CustomModel>("/v2/models/custom", body);
  console.log(
    brand.purple(`✓ Registered custom model "${created.name}" (${created.id}).`),
  );
  console.log(`${brand.bold("identifier:")} ${created.identifier}`);
}

export async function modelsGetCommand(
  opts: ModelsGetOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const m = await api.get<CustomModel>(
    `/v2/models/custom/by-name/${encodeURIComponent(opts.name)}`,
  );
  console.log(`${brand.bold("name:")}       ${m.name}`);
  console.log(`${brand.bold("id:")}         ${m.id}`);
  console.log(`${brand.bold("identifier:")} ${m.identifier}`);
  if (m.type) console.log(`${brand.bold("type:")}       ${m.type}`);
  if (m.provider) console.log(`${brand.bold("provider:")}   ${m.provider}`);
  if (m.extra && Object.keys(m.extra).length > 0) {
    console.log(`${brand.bold("extra:")}      ${JSON.stringify(m.extra)}`);
  }
}
```

- [ ] **Step 4: Wire into `src/index.ts`** — add under `modelsCmd`:

Extend import:

```ts
import {
  modelsListCommand,
  modelsCreateCommand,
  modelsGetCommand,
} from "./commands/models.js";
```

Add:

```ts
modelsCmd
  .command("create")
  .description("Register a custom model (LiteLLM-compatible)")
  .argument("<name>", "friendly name")
  .argument("<identifier>", "LiteLLM identifier (e.g. azure/gpt-4o)")
  .argument("<apiKey>", "API key for the upstream provider")
  .option("--extra <json>", "JSON provider-specific config (api_base, api_version, etc.)")
  .action(async (
    name: string,
    identifier: string,
    apiKey: string,
    cmdOpts: { extra?: string },
  ) => {
    await modelsCreateCommand({
      name,
      identifier,
      apiKey,
      key: program.opts().key,
      ...(cmdOpts.extra ? { extraJson: cmdOpts.extra } : {}),
    });
  });

modelsCmd
  .command("get")
  .description("Show details of a custom model")
  .argument("<name>", "custom model name")
  .action(async (name: string) => {
    await modelsGetCommand({ name, key: program.opts().key });
  });
```

- [ ] **Step 5: Run — PASS.**

- [ ] **Step 6: Commit**

```bash
git add src/commands/models.ts src/index.ts test/commands/models.test.ts
git commit -m "feat: add \`opper models create/get\` (v2 /models/custom)"
```

---

## Task 7: `opper models delete`

**Files:**
- Modify: `src/commands/models.ts`
- Modify: `test/commands/models.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Append test**

```ts
describe("models delete", () => {
  it("looks up by name, DELETEs by id", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockReset();
    getMock.mockResolvedValue({ id: "m_abc", name: "my-gpt4", identifier: "azure/gpt-4o" });
    const delMock = vi.fn().mockResolvedValue(undefined);
    const { OpperApi } = await import("../../src/api/client.js");
    vi.mocked(OpperApi).mockImplementation(
      () => ({ get: getMock, del: delMock }) as unknown as InstanceType<typeof OpperApi>,
    );
    const { modelsDeleteCommand } = await import("../../src/commands/models.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await modelsDeleteCommand({ name: "my-gpt4", key: "default" });
      expect(getMock).toHaveBeenCalledWith("/v2/models/custom/by-name/my-gpt4");
      expect(delMock).toHaveBeenCalledWith("/v2/models/custom/m_abc");
    } finally {
      log.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run — expect failure**

- [ ] **Step 3: Append to `src/commands/models.ts`**

```ts
export interface ModelsDeleteOptions {
  name: string;
  key: string;
}

export async function modelsDeleteCommand(
  opts: ModelsDeleteOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const m = await api.get<CustomModel>(
    `/v2/models/custom/by-name/${encodeURIComponent(opts.name)}`,
  );
  await api.del(`/v2/models/custom/${encodeURIComponent(m.id)}`);
  console.log(brand.purple(`✓ Deleted custom model "${opts.name}".`));
}
```

- [ ] **Step 4: Wire into `src/index.ts`**

```ts
modelsCmd
  .command("delete")
  .description("Delete a custom model by name")
  .argument("<name>", "custom model name")
  .action(async (name: string) => {
    await modelsDeleteCommand({ name, key: program.opts().key });
  });
```

Extend the import.

- [ ] **Step 5: Run — PASS.**

- [ ] **Step 6: Commit**

```bash
git add src/commands/models.ts src/index.ts test/commands/models.test.ts
git commit -m "feat: add \`opper models delete\`"
```

---

## Task 8: `opper usage list`

**Files:**
- Create: `src/commands/usage.ts`
- Create: `test/commands/usage.test.ts`
- Modify: `src/index.ts`

v2 `/analytics/usage` query params: `from_date`, `to_date`, `granularity`, `fields`, `group_by`.

- [ ] **Step 1: Write `test/commands/usage.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const getMock = vi.fn();
vi.mock("../../src/api/client.js", () => ({
  OpperApi: vi.fn().mockImplementation(() => ({ get: getMock })),
}));

const { usageListCommand } = await import("../../src/commands/usage.js");

useTempOpperHome();

describe("usageListCommand", () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it("forwards query params to /v2/analytics/usage", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue([
      {
        time_bucket: "2026-04-21T00:00:00Z",
        cost: 0.001234,
        count: 3,
        total_tokens: 450,
      },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await usageListCommand({
        key: "default",
        fromDate: "2026-04-20",
        toDate: "2026-04-21",
        granularity: "day",
        fields: ["total_tokens"],
        groupBy: ["model"],
      });
      expect(getMock).toHaveBeenCalledWith(
        "/v2/analytics/usage",
        expect.objectContaining({
          from_date: "2026-04-20",
          to_date: "2026-04-21",
          granularity: "day",
          fields: "total_tokens",
          group_by: "model",
        }),
      );
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("2026-04-21");
      expect(out).toContain("450");
    } finally {
      log.mockRestore();
    }
  });

  it("prints CSV when out=csv", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue([
      { time_bucket: "2026-04-21T00:00:00Z", cost: 0.001, count: 2, total_tokens: 100 },
      { time_bucket: "2026-04-22T00:00:00Z", cost: 0.002, count: 5, total_tokens: 200 },
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await usageListCommand({ key: "default", out: "csv", fields: ["total_tokens"] });
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out.split("\n")[0]).toMatch(/time_bucket,cost,count,total_tokens/);
      expect(out).toContain("2026-04-21T00:00:00Z,0.001,2,100");
    } finally {
      log.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- commands/usage`

- [ ] **Step 3: Write `src/commands/usage.ts`**

```ts
import { OpperApi } from "../api/client.js";
import { resolveApiContext } from "../api/resolve.js";
import { printTable } from "../ui/table.js";

export interface UsageListOptions {
  key: string;
  fromDate?: string;
  toDate?: string;
  granularity?: string;
  fields?: string[];
  groupBy?: string[];
  out?: "text" | "csv";
}

type UsageRow = {
  time_bucket?: string;
  cost?: number;
  count?: number;
} & Record<string, unknown>;

export async function usageListCommand(
  opts: UsageListOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const query: Record<string, string | number | undefined> = {};
  if (opts.fromDate) query.from_date = opts.fromDate;
  if (opts.toDate) query.to_date = opts.toDate;
  if (opts.granularity) query.granularity = opts.granularity;
  if (opts.fields?.length) query.fields = opts.fields.join(",");
  if (opts.groupBy?.length) query.group_by = opts.groupBy.join(",");

  const rows = await api.get<UsageRow[]>("/v2/analytics/usage", query);
  if (!Array.isArray(rows) || rows.length === 0) {
    console.log("(no usage data)");
    return;
  }

  const columns = Array.from(
    new Set<string>(
      ["time_bucket", "cost", "count", ...(opts.fields ?? [])].concat(
        rows.flatMap((r) => Object.keys(r)),
      ),
    ),
  );

  if (opts.out === "csv") {
    console.log(columns.join(","));
    for (const row of rows) {
      console.log(
        columns
          .map((c) => {
            const v = row[c as keyof UsageRow];
            if (v === undefined || v === null) return "";
            return String(v);
          })
          .join(","),
      );
    }
    return;
  }

  printTable(
    columns.map((c) => c.toUpperCase()),
    rows.map((row) =>
      columns.map((c) => {
        const v = row[c as keyof UsageRow];
        if (v === undefined || v === null) return "";
        if (c === "cost" && typeof v === "number") return v.toFixed(6);
        return String(v);
      }),
    ),
  );
}
```

- [ ] **Step 4: Wire into `src/index.ts`**

```ts
import { usageListCommand } from "./commands/usage.js";

const usageCmd = program
  .command("usage")
  .description("Analyse usage and costs");

usageCmd
  .command("list")
  .description("List usage rows grouped/bucketed by the given params")
  .option("--from-date <d>", "ISO date or RFC3339 start")
  .option("--to-date <d>", "ISO date or RFC3339 end")
  .option("--granularity <g>", "minute | hour | day | month | year")
  .option("--fields <csv>", "comma-separated extra fields (e.g. total_tokens)")
  .option("--group-by <csv>", "comma-separated group-by keys (e.g. model,customer_id)")
  .option("--out <format>", "text (default) | csv", "text")
  .action(async (cmdOpts: {
    fromDate?: string;
    toDate?: string;
    granularity?: string;
    fields?: string;
    groupBy?: string;
    out?: string;
  }) => {
    const out = cmdOpts.out === "csv" ? "csv" : "text";
    await usageListCommand({
      key: program.opts().key,
      ...(cmdOpts.fromDate ? { fromDate: cmdOpts.fromDate } : {}),
      ...(cmdOpts.toDate ? { toDate: cmdOpts.toDate } : {}),
      ...(cmdOpts.granularity ? { granularity: cmdOpts.granularity } : {}),
      ...(cmdOpts.fields ? { fields: cmdOpts.fields.split(",").map((s) => s.trim()) } : {}),
      ...(cmdOpts.groupBy ? { groupBy: cmdOpts.groupBy.split(",").map((s) => s.trim()) } : {}),
      out: out as "text" | "csv",
    });
  });
```

- [ ] **Step 5: Run — PASS (2 tests). Full suite clean. typecheck + build clean.**

- [ ] **Step 6: Commit**

```bash
git add src/commands/usage.ts src/index.ts test/commands/usage.test.ts
git commit -m "feat: add \`opper usage list\` (v2 /analytics/usage)"
```

---

## Task 9: `opper image generate`

**Files:**
- Create: `src/commands/image.ts`
- Create: `test/commands/image.test.ts`
- Modify: `src/index.ts`

Convenience wrapper over `POST /v3/call` with an image-generation model. Output modes:
- default: save to a timestamped PNG
- `-o path`: save to the given path
- `--base64`: print raw base64 to stdout

- [ ] **Step 1: Write `test/commands/image.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const postMock = vi.fn();
vi.mock("../../src/api/client.js", () => ({
  OpperApi: vi.fn().mockImplementation(() => ({ post: postMock })),
}));

const { imageGenerateCommand } = await import("../../src/commands/image.js");

useTempOpperHome();

describe("imageGenerateCommand", () => {
  let outDir: string;
  beforeEach(() => {
    postMock.mockReset();
    outDir = mkdtempSync(join(tmpdir(), "opper-image-"));
  });
  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("posts to /v3/call with an image model and saves base64 data to file", async () => {
    await setSlot("default", { apiKey: "k" });
    const base64Bytes = Buffer.from("pretend PNG").toString("base64");
    postMock.mockResolvedValue({ data: base64Bytes });
    const target = join(outDir, "out.png");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await imageGenerateCommand({
        prompt: "a cat",
        output: target,
        key: "default",
      });
      expect(postMock).toHaveBeenCalledWith(
        "/v3/call",
        expect.objectContaining({
          input: "a cat",
          model: expect.stringMatching(/imagen|dall|image/i),
        }),
      );
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target).toString()).toBe("pretend PNG");
    } finally {
      log.mockRestore();
    }
  });

  it("prints base64 to stdout when --base64 is set", async () => {
    await setSlot("default", { apiKey: "k" });
    postMock.mockResolvedValue({ data: "BASE64BYTES==" });
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await imageGenerateCommand({
        prompt: "a cat",
        base64: true,
        key: "default",
      });
      const written = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(written.trim()).toBe("BASE64BYTES==");
    } finally {
      spy.mockRestore();
    }
  });

  it("honours --model override", async () => {
    await setSlot("default", { apiKey: "k" });
    postMock.mockResolvedValue({ data: Buffer.from("x").toString("base64") });
    const target = join(outDir, "out.png");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await imageGenerateCommand({
        prompt: "cat",
        model: "openai/dall-e-3",
        output: target,
        key: "default",
      });
      expect(postMock).toHaveBeenCalledWith(
        "/v3/call",
        expect.objectContaining({ model: "openai/dall-e-3" }),
      );
    } finally {
      log.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- commands/image`

- [ ] **Step 3: Write `src/commands/image.ts`**

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpperApi } from "../api/client.js";
import { resolveApiContext } from "../api/resolve.js";
import { OpperError } from "../errors.js";
import { brand } from "../ui/colors.js";

const DEFAULT_IMAGE_MODEL = "gcp/imagen-4.0-fast-generate-001-eu";

export interface ImageGenerateOptions {
  prompt: string;
  key: string;
  model?: string;
  output?: string;
  base64?: boolean;
}

interface CallResponse {
  data?: unknown;
}

function timestampName(): string {
  return `image_${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
}

function extractBase64(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.base64 === "string") return obj.base64;
    if (typeof obj.image === "string") return obj.image;
  }
  return null;
}

export async function imageGenerateCommand(
  opts: ImageGenerateOptions,
): Promise<void> {
  if (opts.output && opts.base64) {
    throw new OpperError(
      "API_ERROR",
      "--output and --base64 are mutually exclusive",
      "Pick one output mode.",
    );
  }

  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const body = {
    name: "cli/image-generate",
    instructions: "Generate an image for the user's prompt.",
    input: opts.prompt,
    model: opts.model ?? DEFAULT_IMAGE_MODEL,
  };
  const result = await api.post<CallResponse>("/v3/call", body);

  const b64 = extractBase64(result.data);
  if (!b64) {
    throw new OpperError(
      "API_ERROR",
      "Upstream did not return image bytes",
      "Check the model supports image generation.",
    );
  }

  if (opts.base64) {
    process.stdout.write(`${b64}\n`);
    return;
  }

  const target = opts.output ?? join(process.cwd(), timestampName());
  const bytes = Buffer.from(b64, "base64");
  await writeFile(target, bytes);
  console.log(brand.purple(`✓ Saved image to ${target}`));
}
```

- [ ] **Step 4: Wire into `src/index.ts`**

```ts
import { imageGenerateCommand } from "./commands/image.js";

const imageCmd = program
  .command("image")
  .description("Image generation");

imageCmd
  .command("generate")
  .description("Generate an image from a prompt")
  .argument("<prompt>", "text prompt")
  .option("-o, --output <path>", "output file path (default: image_<ts>.png in cwd)")
  .option("--base64", "print raw base64 to stdout instead of saving a file")
  .option("-m, --model <id>", "image model identifier")
  .action(async (
    prompt: string,
    cmdOpts: { output?: string; base64?: boolean; model?: string },
  ) => {
    await imageGenerateCommand({
      prompt,
      key: program.opts().key,
      ...(cmdOpts.output ? { output: cmdOpts.output } : {}),
      ...(cmdOpts.base64 ? { base64: true } : {}),
      ...(cmdOpts.model ? { model: cmdOpts.model } : {}),
    });
  });
```

- [ ] **Step 5: Run — PASS (3 tests). typecheck + build clean.**

- [ ] **Step 6: Commit**

```bash
git add src/commands/image.ts src/index.ts test/commands/image.test.ts
git commit -m "feat: add \`opper image generate\`"
```

---

## Task 10: README + final smoke + push

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Expand README Platform section** to add:

```markdown
### Knowledge / indexes
- `opper indexes list [--limit <n>] [--offset <n>]` — List indexes.
- `opper indexes get <name>` — Show details of an index.
- `opper indexes create <name> [--embedding-model <id>]` — Create an index.
- `opper indexes delete <name>` — Delete an index.
- `opper indexes query <name> <query> [--top-k <n>] [--filters <json>]` — Semantic search.
- `opper indexes add <name> <content> [--key <id>] [--metadata <json>]` — Add a document.

### Custom models
- `opper models create <name> <identifier> <apiKey> [--extra <json>]` — Register a custom model.
- `opper models get <name>` — Show details of a custom model.
- `opper models delete <name>` — Remove a custom model.

### Usage analytics
- `opper usage list [--from-date] [--to-date] [--granularity] [--fields] [--group-by] [--out csv]` — Query usage rows.

### Image generation
- `opper image generate <prompt> [-o <file>] [--base64] [-m <model>]` — Generate an image.
```

Insert under the existing "Platform" subsection.

- [ ] **Step 2: Full verification**

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
node dist/index.js --help | head -30
echo "---"
node dist/index.js indexes list 2>&1 || echo "exit=$?"
echo "---"
unset OPPER_HOME
```

- [ ] **Step 4: Commit + push**

```bash
git add README.md
git commit -m "docs: document v2-backed commands (indexes/models/usage/image)"
git push -u origin feat/plan-5-v2-fallback
```

## Report

- Status
- Full test count
- Smoke output
- Commit SHA
- Push outcome
