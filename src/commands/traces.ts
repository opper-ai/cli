import { OpperApi } from "../api/client.js";
import { resolveApiContext } from "../api/resolve.js";
import { brand } from "../ui/colors.js";
import { OpperError } from "../errors.js";
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

// Shapes as /v3/traces actually answers: a `data` envelope both ways, `id`
// (not `uuid`) as the identifier, and `status` only on traces that failed.
interface TraceSummary {
  id: string;
  name?: string;
  status?: string;
  start_time?: string;
  duration_ms?: number;
  span_count?: number;
}

interface ListResponse {
  data: TraceSummary[];
}

interface GetResponse {
  data: TraceSummary & {
    spans?: Array<Record<string, unknown>>;
    [k: string]: unknown;
  };
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
  const rows = (resp.data ?? []).map((t) => [
    t.id,
    t.name ?? "",
    t.status ?? "",
    t.start_time ?? "",
    t.duration_ms ? `${t.duration_ms}ms` : "",
  ]);
  printTable(["ID", "NAME", "STATUS", "START", "DURATION"], rows);
}

export async function tracesGetCommand(
  opts: TracesGetOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const resp = await api.get<GetResponse>(
    `/v3/traces/${encodeURIComponent(opts.id)}`,
  );
  const t = resp.data;
  if (!t) {
    throw new OpperError(
      "API_ERROR",
      `No trace in the response for "${opts.id}"`,
      "The API answered 200 with an unexpected shape — retry, or check the id.",
    );
  }
  console.log(`${brand.bold("id:")}       ${t.id}`);
  if (t.name) console.log(`${brand.bold("name:")}     ${t.name}`);
  if (t.status) console.log(`${brand.bold("status:")}   ${t.status}`);
  if (t.start_time) console.log(`${brand.bold("start:")}    ${t.start_time}`);
  if (t.duration_ms !== undefined) {
    console.log(`${brand.bold("duration:")} ${t.duration_ms}ms`);
  }
  // `??` would keep a `spans: []` and never fall through to the count.
  const spans = t.spans?.length || t.span_count;
  if (spans) console.log(`${brand.bold("spans:")}    ${spans}`);
}

export async function tracesDeleteCommand(
  opts: TracesDeleteOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  await api.del(`/v3/traces/${encodeURIComponent(opts.id)}`);
  console.log(brand.accent(`✓ Deleted trace "${opts.id}".`));
}
