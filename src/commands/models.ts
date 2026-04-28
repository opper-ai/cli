import { OpperApi } from "../api/client.js";
import { resolveApiContext } from "../api/resolve.js";
import { printTable } from "../ui/table.js";
import { brand } from "../ui/colors.js";

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
    brand.accent(`✓ Registered custom model "${created.name}" (${created.id}).`),
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
  console.log(brand.accent(`✓ Deleted custom model "${opts.name}".`));
}
