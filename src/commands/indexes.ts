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
