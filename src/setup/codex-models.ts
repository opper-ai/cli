import { z } from "zod";
import { OpperApi, type OpperApiConfig } from "../api/client.js";
import { OpperError } from "../errors.js";
import { displayName } from "./opencode-models.js";

const compatModelSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().optional(),
  name: z.string().optional(),
  context_length: z.number().optional(),
  opper: z.object({
    kind: z.enum(["model", "pool", "dynamic_route"]).optional(),
    type: z.string().optional(),
    members: z.array(z.string().min(1)).optional(),
    capabilities: z.array(z.string()).optional(),
  }).optional(),
});

const modelMetadataSchema = z.object({
  id: z.string().min(1),
  params: z.object({
    reasoning: z.object({
      supported: z.array(z.string()),
      default: z.string().optional(),
    }).nullish(),
  }).nullish(),
});

export type CodexModelMetadata = z.infer<typeof modelMetadataSchema>;
const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
type ReasoningEffort = typeof REASONING_EFFORTS[number];

export type CodexCompatModel = z.infer<typeof compatModelSchema>;

/** ModelInfo fields consumed by Codex's model_catalog_json (verified on 0.153.4). */
export interface CodexModel {
  slug: string;
  display_name: string;
  description: string;
  supported_reasoning_levels: { effort: ReasoningEffort; description: string }[];
  default_reasoning_level?: ReasoningEffort;
  supports_reasoning_summaries: boolean;
  shell_type: "shell_command";
  visibility: "list";
  supported_in_api: true;
  priority: number;
  base_instructions: string;
  default_reasoning_summary: "none";
  support_verbosity: false;
  truncation_policy: { mode: "tokens"; limit: number };
  experimental_supported_tools: [];
  input_modalities: ("text" | "image")[];
  context_window: number;
}

export interface CodexModelCatalog {
  models: CodexModel[];
}

// A catalog entry requires instructions. Use a provider-neutral prompt authored
// here rather than copying an OpenAI model's private prompt and tool assumptions.
const BASE_INSTRUCTIONS = "You are a coding assistant working with the user in a shared workspace. " +
  "Follow the user's request and applicable workspace instructions. " +
  "Use the available tools to inspect relevant files, make focused changes, and verify the result. " +
  "Preserve unrelated user work, explain material limitations, and report what changed and what was tested.";

const FALLBACK_CONTEXT = 32_000;

function reasoningFor(entry: CodexCompatModel, metadata: Map<string, CodexModelMetadata>) {
  const ids = entry.opper?.kind === "pool"
    ? entry.opper.members ?? []
    : entry.opper?.kind === "dynamic_route" ? [] : [entry.id];
  const members = ids.map((id) => metadata.get(id)?.params?.reasoning);
  // A pool can land on any permitted member. Unknown metadata must therefore
  // remove choices, even when other members advertise reasoning capabilities.
  const efforts = members.length === 0 ? [] : REASONING_EFFORTS.filter((effort) =>
    members.every((member) => member?.supported.includes(effort)),
  );
  const commonDefault = members[0]?.default;
  const defaultEffort = efforts.find((effort) => effort === commonDefault &&
    members.every((member) => member?.default === commonDefault)) ??
    efforts.find((effort) => effort === "medium") ?? efforts[0];
  return {
    supported_reasoning_levels: efforts.map((effort) => ({
      effort,
      description: effort === "none" ? "Disable reasoning" : `${effort[0]!.toUpperCase()}${effort.slice(1)} reasoning effort`,
    })),
    ...(defaultEffort ? { default_reasoning_level: defaultEffort } : {}),
    // Some Codex versions use this flag when constructing reasoning options.
    // Keep summary generation opted out with default_reasoning_summary: "none".
    supports_reasoning_summaries: efforts.length > 0,
  };
}

/**
 * Only advertise models with confirmed tool support: Codex requires tools for
 * ordinary coding work. A route with unknown capabilities is not sufficient
 * evidence. IDs stay exactly as returned by the caller-scoped gateway catalog.
 */
export function toCodexModelCatalog(
  entries: CodexCompatModel[],
  selectedModel: string,
  modelMetadata: CodexModelMetadata[] = [],
): CodexModelCatalog {
  const metadata = new Map(modelMetadata.map((entry) => [entry.id, entry]));
  const usable = entries.filter((entry) =>
    (entry.opper?.type === "llm" || entry.opper?.kind === "dynamic_route") &&
    entry.opper.capabilities?.includes("tools"),
  );
  const unique = [...new Map(usable.map((entry) => [entry.id, entry])).values()];
  if (unique.length === 0) {
    throw new OpperError("API_ERROR", "No tool-capable models are available to this Opper key.");
  }
  if (!unique.some((entry) => entry.id === selectedModel)) {
    throw new OpperError(
      "INVALID_ARGUMENT",
      `Model "${selectedModel}" is not available as a tool-capable model to this Opper key.`,
      "Choose a model from the selected key's model catalog.",
    );
  }
  // Keep the gateway order (which puts featured models first), moving only the
  // selected model to the front so Codex marks that entry as the default.
  const ordered = [
    ...unique.filter((entry) => entry.id === selectedModel),
    ...unique.filter((entry) => entry.id !== selectedModel),
  ];
  return {
    models: ordered.map((entry, priority) => {
      const context = Number.isFinite(entry.context_length) && entry.context_length! > 0
        ? Math.floor(entry.context_length!)
        : FALLBACK_CONTEXT;
      return {
        slug: entry.id,
        display_name: entry.display_name || entry.name || displayName(entry.id),
        description: `Via Opper · ${entry.id}`,
        ...reasoningFor(entry, metadata),
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority,
        base_instructions: BASE_INSTRUCTIONS,
        default_reasoning_summary: "none",
        support_verbosity: false,
        truncation_policy: { mode: "tokens", limit: Math.max(1, Math.min(10_000, Math.floor(context / 4))) },
        experimental_supported_tools: [],
        input_modalities: entry.opper?.capabilities?.includes("vision") ? ["text", "image"] : ["text"],
        context_window: context,
      };
    }),
  };
}

/**
 * Discovery uses the same explicitly selected credential and API root as the
 * provider. /v3/compat/models already filters denied models and pool members.
 * Authentication, network, and schema errors must abort configuration instead
 * of replacing the authorized catalog with an unrestricted baked-in fallback.
 */
export async function fetchCodexModelCatalog(
  context: OpperApiConfig,
  selectedModel: string,
): Promise<CodexModelCatalog> {
  const api = new OpperApi(context);
  const response = await api.get<unknown>("/v3/compat/models");
  const parsed = z.object({ data: z.array(compatModelSchema) }).safeParse(response);
  if (!parsed.success) {
    throw new OpperError("API_ERROR", "Opper returned an invalid model catalog.");
  }
  // The gateway explicitly supports limit=0 for the complete catalog. This
  // adds effort metadata only; the compat catalog remains the ID authority.
  const metadataResponse = await api.get<unknown>("/v3/models?limit=0");
  const metadata = z.object({ models: z.array(modelMetadataSchema) }).safeParse(metadataResponse);
  if (!metadata.success) {
    throw new OpperError("API_ERROR", "Opper returned invalid model reasoning metadata.");
  }
  return toCodexModelCatalog(parsed.data.data, selectedModel, metadata.data.models);
}
