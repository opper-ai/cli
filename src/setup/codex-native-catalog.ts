import { z } from "zod";
import { OpperApi, type OpperApiConfig } from "../api/client.js";
import { OpperError } from "../errors.js";
import { run } from "../util/run.js";
import { validateModelKinds, type ModelKinds } from "./model-catalog.js";

/** Presence or the older local-file version threshold does not imply support. */
export function supportsNativeCodexCatalog(binary: string, codexHome?: string, featureOverrides: readonly string[] = []): boolean {
  const result = run(binary, ["features", "list", ...featureOverrides], { timeout: 5_000, ...(codexHome ? { env: { ...process.env, CODEX_HOME: codexHome } } : {}) });
  return result.code === 0 && /^api_key_model_discovery\s+.+?\s+true\s*$/m.test(result.stdout);
}

const modelSchema = z.object({
  slug: z.string().min(1), display_name: z.string(), description: z.string(),
  supported_reasoning_levels: z.array(z.object({ effort: z.string(), description: z.string() })),
  default_reasoning_level: z.string().optional(), supports_reasoning_summaries: z.boolean(),
  shell_type: z.literal("shell_command"), visibility: z.literal("list"), supported_in_api: z.literal(true),
  priority: z.number().int().nonnegative(), base_instructions: z.string().min(1),
  default_reasoning_summary: z.literal("none"), support_verbosity: z.boolean(),
  truncation_policy: z.object({ mode: z.literal("tokens"), limit: z.number().int().positive() }),
  experimental_supported_tools: z.array(z.string()), input_modalities: z.array(z.enum(["text", "image"])).min(1),
  context_window: z.number().int().positive(),
}).passthrough();

export function codexCatalogUrl(baseUrl: string, selectedModel: string, modelKinds: ModelKinds = "pools,routes"): string {
  validateModelKinds(modelKinds);
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/v3/compat/models`);
  url.searchParams.set("format", "codex");
  if (modelKinds !== "all") url.searchParams.set("type", "pool,dynamic_route");
  url.searchParams.set("selected_model", selectedModel);
  return url.href;
}

/** A single selected_model exception cannot preserve older hidden selections. */
export function nativeCodexRefreshKinds(selectedModel: string, requested?: ModelKinds, previousUrl?: string, hadLocalCatalog = false): ModelKinds {
  if (hadLocalCatalog) return "all";
  if (previousUrl) {
    const params = new URL(previousUrl).searchParams;
    if (!params.has("type") || params.get("selected_model") !== selectedModel) return "all";
  }
  return requested ?? "pools,routes";
}

/**
 * Probe rollout support without changing configuration. Only a valid legacy
 * OpenAI envelope proves unsupported format; auth, transport and malformed native
 * metadata fail closed. Future catalog refreshes belong to the Codex runtime.
 */
export async function nativeCodexCatalog(
  context: OpperApiConfig, selectedModel: string, modelKinds: ModelKinds = "pools,routes",
): Promise<{ url: string; modelCount: number } | undefined> {
  const url = codexCatalogUrl(context.baseUrl, selectedModel, modelKinds);
  const path = `/v3/compat/models${new URL(url).search}`;
  const value = await new OpperApi(context).get<unknown>(path, undefined, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (value && typeof value === "object" && !Object.hasOwn(value, "models")) {
    if (z.object({ data: z.array(z.object({ id: z.string().min(1) })) }).safeParse(value).success) return;
  }
  const parsed = z.object({ models: z.array(modelSchema) }).safeParse(value);
  if (!parsed.success || new Set(parsed.data.models.map(model => model.slug)).size !== parsed.data.models.length) {
    throw new OpperError("API_ERROR", "Opper returned invalid native Codex model metadata.");
  }
  if (!parsed.data.models.some(model => model.slug === selectedModel)) {
    throw new OpperError("INVALID_ARGUMENT", `Model "${selectedModel}" is not available in this credential's native Codex catalog.`);
  }
  return { url, modelCount: parsed.data.models.length };
}
