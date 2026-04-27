/**
 * Opper API endpoints. Single source of truth — every adapter, command,
 * and bundled-config writer reads from here. When the platform team
 * confirms a path or moves it, change it once.
 *
 * The base host can be overridden per-slot in `~/.opper/config.json` (for
 * staging / on-prem deployments); the compat sub-paths are stable.
 */
export const OPPER_HOST = "https://api.opper.ai";

/** OpenAI Chat Completions / Responses-shaped compat endpoint. */
export const OPPER_OPENAI_COMPAT_URL = `${OPPER_HOST}/v3/openai`;

/** Anthropic Messages-shaped compat endpoint. */
export const OPPER_ANTHROPIC_COMPAT_URL = `${OPPER_HOST}/v3/compat`;

/** v3 native endpoints (call, models, functions, traces, etc.). */
export const OPPER_V3_BASE = `${OPPER_HOST}/v3`;

/**
 * Backwards-compatible re-export so older imports
 * (`from "../api/compat.js"`) keep working until they're migrated.
 *
 * @deprecated import from `src/config/endpoints.ts` instead.
 */
export { OPPER_OPENAI_COMPAT_URL as default };
