import { OpperApi } from "../api/client.js";
import { resolveApiContext } from "../api/resolve.js";
import { printTable } from "../ui/table.js";
import { brand } from "../ui/colors.js";

/**
 * Server-side filters on GET /v3/models. Each is a comma-separated list of
 * alternatives and they combine, the same way a model access rule on the
 * Rules page does.
 */
export interface ModelsListFilters {
  inferenceLocation?: string;
  storageLocation?: string;
  training?: string;
  logging?: string;
  moderation?: string;
}

export interface ModelsListOptions extends ModelsListFilters {
  key: string;
  projectUuid?: string | undefined;
  filter?: string;
  json?: boolean;
}

export interface ModelCompliance {
  inference_location?: string;
  storage_location?: string;
  training?: string;
  logging?: string;
  moderation?: string;
}

export interface OpperModel {
  id: string;
  name?: string;
  context_window?: number;
  compliance?: ModelCompliance;
}

const FILTER_PARAMS: Array<[keyof ModelsListFilters, string]> = [
  ["inferenceLocation", "inference_location"],
  ["storageLocation", "storage_location"],
  ["training", "training"],
  ["logging", "logging"],
  ["moderation", "moderation"],
];

interface ModelsResponse {
  models: OpperModel[];
}

/**
 * Fetch the full Opper model catalog. Useful for interactive pickers.
 */
export async function fetchModels(key: string, projectUuid?: string): Promise<OpperModel[]> {
  const ctx = await resolveApiContext(key, { projectUuid });
  const api = new OpperApi(ctx);
  const resp = await api.get<ModelsResponse>("/v3/models?limit=500");
  return resp.models;
}

export async function modelsListCommand(opts: ModelsListOptions): Promise<void> {
  const ctx = await resolveApiContext(opts.key, { projectUuid: opts.projectUuid });
  const api = new OpperApi(ctx);
  // limit=0 returns every row; the default page is 50 of a catalog of 1000+.
  const params = new URLSearchParams({ limit: "0" });
  for (const [opt, param] of FILTER_PARAMS) {
    const value = opts[opt];
    if (value) params.set(param, value);
  }
  const resp = await api.get<ModelsResponse>(`/v3/models?${params.toString()}`);
  const filter = opts.filter?.toLowerCase();
  const models = resp.models.filter((m) =>
    filter
      ? (m.name ?? "").toLowerCase().includes(filter) ||
        m.id.toLowerCase().includes(filter)
      : true,
  );
  if (opts.json) {
    console.log(JSON.stringify(models, null, 2));
    return;
  }
  const rows = models.map((m) => [
    m.name ?? "",
    m.id,
    m.context_window ? m.context_window.toString() : "",
    m.compliance?.inference_location ?? "",
    m.compliance?.training ?? "",
    m.compliance?.logging ?? "",
    m.compliance?.moderation ?? "",
  ]);
  printTable(["NAME", "ID", "CONTEXT", "LOCATION", "TRAINING", "LOGGING", "MODERATION"], rows);
}

export interface ModelsCreateOptions {
  name: string;
  identifier: string;
  apiKey: string;
  extraJson?: string;
  key: string;
  projectUuid?: string | undefined;
}

export interface ModelsGetOptions {
  name: string;
  key: string;
  projectUuid?: string | undefined;
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
  const ctx = await resolveApiContext(opts.key, { projectUuid: opts.projectUuid });
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
  const ctx = await resolveApiContext(opts.key, { projectUuid: opts.projectUuid });
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
  projectUuid?: string | undefined;
}

export async function modelsDeleteCommand(
  opts: ModelsDeleteOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key, { projectUuid: opts.projectUuid });
  const api = new OpperApi(ctx);
  const m = await api.get<CustomModel>(
    `/v2/models/custom/by-name/${encodeURIComponent(opts.name)}`,
  );
  await api.del(`/v2/models/custom/${encodeURIComponent(m.id)}`);
  console.log(brand.accent(`✓ Deleted custom model "${opts.name}".`));
}
