import { z } from "zod";
import { OpperApi, type OpperApiConfig } from "../api/client.js";
import type { ConductorModelKinds } from "../agents/types.js";
import { OpperError } from "../errors.js";
import { toCodexModelCatalog, type CodexCompatModel, type CodexModelCatalog, type CodexModelMetadata } from "./codex-models.js";
import { compatPickerDisplayName, displayName } from "./opencode-models.js";

// Keep the same boundary validation as Codex discovery. Conductor has its own
// selection policy; existing Codex/Desktop discovery retains its full catalog.
const entrySchema = z.object({
  id: z.string().min(1), display_name: z.string().optional(), name: z.string().optional(), context_length: z.number().optional(),
  opper: z.object({
    kind: z.enum(["model", "pool", "dynamic_route"]).optional(), display_name: z.string().optional(),
    pricing: z.object({kind: z.literal("variable")}).optional(), type: z.string().optional(),
    members: z.array(z.string().min(1)).optional(), capabilities: z.array(z.string()).optional(),
  }).optional(),
});
const reasoningSchema = z.object({
  id: z.string().min(1), params: z.object({reasoning: z.object({
    supported: z.array(z.string()), default: z.string().optional(),
  }).nullish()}).nullish(),
});
function validateKinds(value: ConductorModelKinds): void {
  if (value !== "pools,routes" && value !== "all") throw new OpperError("INVALID_ARGUMENT", "--model-kinds must be pools,routes or all.");
}
function rank(entry: CodexCompatModel): number {
  return entry.opper?.kind === "dynamic_route" ? 0 : entry.opper?.kind === "pool" ? 1 : 2;
}
function label(entry: CodexCompatModel): string {
  const fallback = displayName(entry.id.slice(entry.id.lastIndexOf("/") + 1));
  const name = entry.opper?.display_name?.trim() || entry.display_name?.trim() || entry.name?.trim() || fallback;
  const kind = entry.opper?.kind;
  if (kind === "dynamic_route") return compatPickerDisplayName({id: entry.id, opper: {kind, display_name: name}});
  // Kind is authoritative, even for a namespaced pool or a bare deployment ID.
  const suffix = kind === "pool" ? ` (pool)${entry.id.includes("/") ? ` · ${entry.id}` : ""}` : ` · ${entry.id}`;
  return name + suffix + (entry.opper?.pricing?.kind === "variable" ? " · Variable pricing" : "");
}

export function toConductorModelCatalog(
  entries: CodexCompatModel[], selectedModel: string,
  modelKinds: ConductorModelKinds = "pools,routes", metadata: CodexModelMetadata[] = [],
): CodexModelCatalog {
  validateKinds(modelKinds);
  // Reuse the existing tool gating, selected-model validation, exact IDs and
  // reasoning intersection. Do not silently fall back to provider deployments.
  const catalog = toCodexModelCatalog(entries, selectedModel, metadata);
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const models = catalog.models.filter(model => {
    const kind = byId.get(model.slug)?.opper?.kind;
    return modelKinds === "all" || model.slug === selectedModel || kind === "pool" || kind === "dynamic_route";
  }).sort((a, b) => {
    if (a.slug === selectedModel) return -1;
    if (b.slug === selectedModel) return 1;
    return rank(byId.get(a.slug)!) - rank(byId.get(b.slug)!);
  });
  return {models: models.map((model, priority) => ({...model, priority, display_name: label(byId.get(model.slug)!)}))};
}

export async function fetchConductorModelCatalog(
  context: OpperApiConfig, selectedModel: string, modelKinds: ConductorModelKinds = "pools,routes",
): Promise<CodexModelCatalog> {
  validateKinds(modelKinds);
  const api = new OpperApi(context);
  const entries = z.object({data: z.array(entrySchema)}).safeParse(await api.get<unknown>("/v3/compat/models"));
  if (!entries.success) throw new OpperError("API_ERROR", "Opper returned an invalid model catalog.");
  const metadata = z.object({models: z.array(reasoningSchema)}).safeParse(await api.get<unknown>("/v3/models?limit=0"));
  if (!metadata.success) throw new OpperError("API_ERROR", "Opper returned invalid model reasoning metadata.");
  return toConductorModelCatalog(entries.data.data, selectedModel, modelKinds, metadata.data.models);
}
