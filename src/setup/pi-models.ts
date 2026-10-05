import { OpperApi, type OpperApiConfig } from "../api/client.js";
import { OpperError } from "../errors.js";
import { pickerDisplayName, type CompatModel } from "./opencode-models.js";

export interface PiModel {
  id: string; name: string; contextWindow: number; maxTokens: number;
  input: string[]; reasoning: boolean;
  thinkingLevelMap: Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>;
  compat: { supportsReasoningEffort: boolean };
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

// Pi calculates usage cost from these rates, not the gateway's usage.cost.
// Pi requires numeric rates, so unknown prices fall back to zero. A pool's
// catalog price is an estimate; Opper usage remains the billing source of truth.
function piPrice(raw: string | undefined): number {
  if (raw === undefined || !raw.trim()) return 0;
  const value = Number(raw);
  const converted = Math.round(value * 1_000_000 * 1e6) / 1e6;
  return Number.isFinite(converted) && value >= 0 ? converted : 0;
}

function piReasoning(entry: CompatModel, legacyMaxLevel: boolean): Pick<PiModel, "reasoning" | "thinkingLevelMap" | "compat"> {
  const supported = entry.opper?.reasoning?.supported ?? [];
  // Capability flags describe model output, not the efforts a particular
  // endpoint accepts. Null is essential: omitted Pi levels enable defaults.
  const thinkingLevelMap: PiModel["thinkingLevelMap"] = {
    off: supported.includes("none") ? "none" : null,
    minimal: supported.includes("minimal") ? "minimal" : null,
    low: supported.includes("low") ? "low" : null,
    medium: supported.includes("medium") ? "medium" : null,
    high: supported.includes("high") ? "high" : null,
    // Older Pi has no max selector; its documented xhigh->max mapping
    // exposes max effort without inventing an unsupported provider value.
    xhigh: supported.includes("xhigh") ? "xhigh" : legacyMaxLevel && supported.includes("max") ? "max" : null,
    max: supported.includes("max") ? "max" : null,
  };
  const reasoning = Object.entries(thinkingLevelMap).some(([level, effort]) => level !== "off" && effort !== null);
  return { reasoning, thinkingLevelMap, compat: { supportsReasoningEffort: reasoning } };
}
export async function fetchPiModels(context: OpperApiConfig, options: {legacyMaxLevel?: boolean} = {}): Promise<PiModel[]> {
  const response = await new OpperApi(context).get<{ data?: CompatModel[] }>("/v3/compat/models");
  if (!Array.isArray(response.data)) throw new OpperError("API_ERROR", "Invalid model catalog response: expected a data array.");
  const models = response.data.flatMap((entry): PiModel[] => {
    const caps = entry.opper?.capabilities ?? [];
    const context = entry.context_length;
    const output = entry.opper?.max_output_tokens;
    if (!entry.id || (entry.opper?.type && entry.opper.type !== "llm") || !caps.includes("tools") ||
        !Number.isSafeInteger(context) || !Number.isSafeInteger(output) || !context || !output || output <= 0 || context <= output) return [];
    return [{ id: entry.id, name: pickerDisplayName(entry.id), contextWindow: context, maxTokens: output,
      input: caps.includes("vision") ? ["text", "image"] : ["text"], ...piReasoning(entry, options.legacyMaxLevel ?? false),
      cost: { input: piPrice(entry.pricing?.prompt), output: piPrice(entry.pricing?.completion),
        cacheRead: piPrice(entry.pricing?.input_cache_read), cacheWrite: piPrice(entry.pricing?.input_cache_write) } }];
  });
  if (!models.length) throw new OpperError("API_ERROR", "No allowed tool-capable models with valid context limits are available for Pi.");
  return models;
}
