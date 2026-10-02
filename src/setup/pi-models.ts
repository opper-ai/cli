import { OpperApi, type OpperApiConfig } from "../api/client.js";
import { OpperError } from "../errors.js";
import { pickerDisplayName, type CompatModel } from "./opencode-models.js";

export interface PiModel {
  id: string; name: string; contextWindow: number; maxTokens: number;
  input: string[]; reasoning: boolean;
}
export async function fetchPiModels(context: OpperApiConfig): Promise<PiModel[]> {
  const response = await new OpperApi(context).get<{ data?: CompatModel[] }>("/v3/compat/models");
  if (!Array.isArray(response.data)) throw new OpperError("API_ERROR", "Invalid model catalog response: expected a data array.");
  const models = response.data.flatMap((entry): PiModel[] => {
    const caps = entry.opper?.capabilities ?? [];
    const context = entry.context_length;
    const output = entry.opper?.max_output_tokens;
    if (!entry.id || (entry.opper?.type && entry.opper.type !== "llm") || !caps.includes("tools") ||
        !Number.isSafeInteger(context) || !Number.isSafeInteger(output) || !context || !output || output <= 0 || context <= output) return [];
    return [{ id: entry.id, name: pickerDisplayName(entry.id), contextWindow: context, maxTokens: output,
      input: caps.includes("vision") ? ["text", "image"] : ["text"], reasoning: caps.includes("reasoning") || caps.includes("thinking") }];
  });
  if (!models.length) throw new OpperError("API_ERROR", "No allowed tool-capable models with valid context limits are available for Pi.");
  return models;
}
