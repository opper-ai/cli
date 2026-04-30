/**
 * Default model identifiers used across the CLI. These appear in:
 *   - `opper launch <agent>`'s `--model` default (when the user didn't pick one)
 *   - the env vars Claude Code reads at spawn time
 *   - the [profiles.opper-X] blocks Codex's adapter writes into config.toml
 *
 * Bumping a model here updates every consumer in one go.
 */
export const DEFAULT_MODELS = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
  /** Image generation default (Imagen via Opper). */
  image: "vertexai/imagen-4.0-fast-generate-001-eu",
} as const;
