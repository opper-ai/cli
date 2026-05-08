/**
 * Default model identifiers used across the CLI. These appear in:
 *   - `opper launch <agent>`'s `--model` default (when the user didn't pick one)
 *   - the env vars Claude Code reads at spawn time
 *   - the [profiles.opper-X] blocks Codex's adapter writes into config.toml
 *
 * Bumping a model here updates every consumer in one go.
 *
 * The Claude entries use Opper's vendor-agnostic aliases (no `anthropic/`
 * prefix) so the gateway can transparently fall back across upstream
 * providers / regions when one is degraded.
 */
export const DEFAULT_MODELS = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
  gpt: "gpt-5.5",
  gemini: "gemini-3.1-pro-preview",
  /** Image generation default (Imagen via Opper). */
  image: "vertexai/imagen-4.0-fast-generate-001-eu",
} as const;

/**
 * The set of models we expose by default in adapter pickers (Pi, OpenClaw,
 * Claude Desktop, Codex). Claude Code and OpenCode pull their lists from
 * elsewhere (the gateway's /v1/models endpoint and the OpenCode template,
 * respectively).
 *
 * TODO: replace this hardcoded list with a fetch from /v3/models filtered
 * to a "featured" set once the platform exposes it.
 */
export interface PickerModel {
  /** Gateway model id passed to /v3/call (and compat). */
  id: string;
  contextWindow: number;
  reasoning: boolean;
  /** Codex profile suffix — becomes `[profiles.opper-<suffix>]`. */
  codexProfile: string;
}

export const PICKER_MODELS: ReadonlyArray<PickerModel> = [
  { id: DEFAULT_MODELS.opus,           contextWindow: 1_000_000, reasoning: true,  codexProfile: "opus" },
  { id: DEFAULT_MODELS.sonnet,         contextWindow: 1_000_000, reasoning: true,  codexProfile: "sonnet" },
  { id: DEFAULT_MODELS.haiku,          contextWindow:   200_000, reasoning: false, codexProfile: "haiku" },
  { id: DEFAULT_MODELS.gpt,            contextWindow: 1_050_000, reasoning: true,  codexProfile: "gpt" },
  { id: DEFAULT_MODELS.gemini,         contextWindow: 1_048_576, reasoning: true,  codexProfile: "gemini" },
  { id: "deepinfra/kimi-k2.6",         contextWindow:   262_144, reasoning: true,  codexProfile: "kimi" },
  { id: "deepinfra/glm-5.1",           contextWindow:   202_752, reasoning: true,  codexProfile: "glm" },
  { id: "fireworks/minimax-m2p7",      contextWindow:   196_608, reasoning: false, codexProfile: "minimax" },
  { id: "deepinfra/deepseek-v4-pro",   contextWindow: 1_048_576, reasoning: true,  codexProfile: "deepseek-pro" },
  { id: "deepinfra/deepseek-v4-flash", contextWindow: 1_048_576, reasoning: true,  codexProfile: "deepseek-flash" },
];

/**
 * Return PICKER_MODELS reordered so `launchModel` is at index 0. When the
 * launch model isn't in the picker set (e.g. user passed `--model X` for
 * a non-curated id), it's prepended as a minimal entry.
 *
 * Adapters that bake a list into agent config (Pi, OpenClaw) treat
 * `models[0]` as the default — this keeps that contract regardless of
 * where the launch model sits in PICKER_MODELS.
 */
export function pickerModelsForLaunch(launchModel: string): PickerModel[] {
  const idx = PICKER_MODELS.findIndex((m) => m.id === launchModel);
  if (idx === -1) {
    return [
      { id: launchModel, contextWindow: 200_000, reasoning: true, codexProfile: "" },
      ...PICKER_MODELS,
    ];
  }
  const head = PICKER_MODELS[idx]!;
  return [head, ...PICKER_MODELS.filter((_, i) => i !== idx)];
}
