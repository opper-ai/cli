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
