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
  console.log(brand.accent(`✓ Deleted function "${opts.name}".`));
}
