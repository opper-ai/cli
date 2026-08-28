/**
 * Builds OpenCode's `provider.opper.models` map from the live catalogue.
 *
 * The bundled `data/opencode.json` template carries a hand-maintained model
 * list, frozen whenever the package was published. That list rots silently:
 * the sibling copy in the `setup` repo drifted to 14-of-22 delisted models and
 * a legacy base URL before anyone noticed. Worse, a static list can only ever
 * name concrete models — a user's own pools and dynamic routes are invisible,
 * which is the one thing Opper offers that a plain OpenAI-compatible provider
 * cannot.
 *
 * `/v3/compat/models` fixes all of that in one call: it is scoped to the API
 * key, so it already reflects the org's model-access rules, and it returns
 * pools and `dynamic/<name>` routes alongside concrete models.
 *
 * OpenCode MERGES a custom provider block with the models.dev registry entry
 * for the same provider id rather than replacing it (verified against
 * opencode-ai 1.14.41: models.dev's 40 `opper` models and a 10-model custom
 * block yielded 60 entries). So everything written here is additive — a model
 * omitted for want of pricing is not thereby removed from the picker.
 */

import { OpperApi } from "../api/client.js";
import { resolveApiContext } from "../api/resolve.js";

/** One entry of `/v3/compat/models`. Only the fields this mapping reads. */
export interface CompatModel {
  id: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
  opper?: {
    kind?: "model" | "pool" | "dynamic_route";
    type?: string;
    capabilities?: string[];
    max_output_tokens?: number;
  };
}

/** An OpenCode `provider.<id>.models.<key>` value; see opencode.ai/config.json. */
export interface OpenCodeModel {
  name: string;
  tool_call: boolean;
  reasoning: boolean;
  attachment: boolean;
  cost: {
    input: number;
    output: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit: { context: number; output: number };
  modalities?: { input: string[]; output: string[] };
}

/**
 * Fall-backs for an entry whose limits the gateway does not report. A pool
 * reports the floor every member can honour, so a missing value means "not
 * resolvable server-side" (an org-scoped BYOK member, say) rather than
 * "unlimited". Deliberately modest: too high and OpenCode packs a context the
 * served model rejects.
 */
const FALLBACK_CONTEXT = 128_000;
const FALLBACK_OUTPUT = 8_192;

/** `/v3/compat/models` prices are USD per token; OpenCode wants per million. */
const PER_MTOK = 1_000_000;

function price(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseFloat(raw);
  // A free model legitimately prices at 0, so only a non-finite parse is a miss.
  if (!Number.isFinite(n)) return undefined;
  // Scaling a per-token price by a million reintroduces binary-float noise
  // (0.0000002 -> 0.19999999999999998); OpenCode prints these verbatim.
  return Math.round(n * PER_MTOK * 1e6) / 1e6;
}

/**
 * A human label for a catalogue id.
 *
 * `/v3/compat/models` carries no display name, so it is derived: drop the
 * provider/maker prefix, then title-case the remainder. `dynamic/<name>` keeps
 * its prefix as a badge — a route and a model with the same name are different
 * things, and the picker is the only place a user sees which one they picked.
 */
export function displayName(id: string): string {
  if (id.startsWith("dynamic/")) return `${prettify(id.slice("dynamic/".length))} (route)`;
  const tail = id.slice(id.lastIndexOf("/") + 1);
  return prettify(tail);
}

function prettify(s: string): string {
  return s
    .split(/[-_]/)
    .map((w) => (/^[0-9]/.test(w) || w.length <= 2 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}

/**
 * Map catalogue entries to OpenCode's shape.
 *
 * Entries without both a prompt and a completion price are skipped: OpenCode
 * renders per-session cost from these numbers, and a silent 0 reads as "this
 * model is free" rather than "we don't know". Non-LLM rows (image, tts, …) are
 * skipped too — OpenCode's picker is for chat.
 */
export function toOpenCodeModels(entries: CompatModel[]): Record<string, OpenCodeModel> {
  const out: Record<string, OpenCodeModel> = {};
  for (const e of entries) {
    const type = e.opper?.type ?? "llm";
    if (type !== "llm" && e.opper?.kind !== "dynamic_route") continue;

    // A dynamic route is a routing graph, not a model: the gateway reports no
    // price, context or capabilities for it because the graph only decides
    // per request. Skipping it on those grounds would drop the one thing a
    // static list could never carry, so it is admitted on route defaults.
    if (e.opper?.kind === "dynamic_route") {
      out[e.id] = routeEntry(e.id);
      continue;
    }

    const input = price(e.pricing?.prompt);
    const output = price(e.pricing?.completion);
    if (input === undefined || output === undefined) continue;

    const caps = e.opper?.capabilities ?? [];
    const cacheRead = price(e.pricing?.input_cache_read);
    const cacheWrite = price(e.pricing?.input_cache_write);
    const inputModalities = ["text"];
    if (caps.includes("vision")) inputModalities.push("image");
    if (caps.includes("pdf")) inputModalities.push("pdf");

    out[e.id] = {
      name: displayName(e.id),
      // Agent mode is unusable without tool calling, and OpenCode trusts this
      // flag rather than probing — a wrong `true` fails mid-session.
      tool_call: caps.includes("tools"),
      reasoning: caps.includes("reasoning") || caps.includes("thinking"),
      attachment: caps.includes("vision") || caps.includes("pdf"),
      cost: {
        input,
        output,
        ...(cacheRead !== undefined ? { cache_read: cacheRead } : {}),
        ...(cacheWrite !== undefined ? { cache_write: cacheWrite } : {}),
      },
      limit: {
        context: e.context_length || FALLBACK_CONTEXT,
        output: e.opper?.max_output_tokens || FALLBACK_OUTPUT,
      },
      modalities: { input: inputModalities, output: ["text"] },
    };
  }
  return out;
}

/**
 * A `dynamic/<name>` route as OpenCode needs to see it.
 *
 * `cost` is required by OpenCode's schema but genuinely unknowable here — the
 * graph picks the model per request, so the real rate is only known after the
 * fact. Zero is the honest placeholder for "we cannot price this in advance";
 * it makes OpenCode's running session cost under-count routes, and Opper's own
 * usage reporting stays the source of truth. `tool_call` is true for the same
 * reason the VS Code extension defaults it on: most routes land on tool-capable
 * models, and a route excluded from agent mode is a route nobody can use.
 */
function routeEntry(id: string): OpenCodeModel {
  return {
    name: displayName(id),
    tool_call: true,
    reasoning: false,
    attachment: false,
    cost: { input: 0, output: 0 },
    limit: { context: FALLBACK_CONTEXT, output: FALLBACK_OUTPUT },
    modalities: { input: ["text"], output: ["text"] },
  };
}

/**
 * Fetch and map the live catalogue, or null when it cannot be reached.
 *
 * Null is the caller's signal to keep the bundled template: a network blip or
 * an expired key must not leave the user with an empty picker, and OpenCode
 * merges with models.dev regardless.
 */
/**
 * The live model map for a config write, or undefined to keep the template.
 *
 * Both entry points that write OpenCode's config — `opper launch opencode` and
 * `opper editors opencode` — go through here, so neither can quietly fall back
 * to the frozen bundled list while the other stays current.
 */
export async function resolveOpenCodeModels(): Promise<
  Record<string, OpenCodeModel> | undefined
> {
  try {
    const { apiKey, baseUrl } = await resolveApiContext("default");
    const fetched = await fetchOpenCodeModels(new OpperApi({ apiKey, baseUrl }));
    return fetched ?? undefined;
  } catch {
    // No configured key — the bundled list is the honest fallback.
    return undefined;
  }
}

export async function fetchOpenCodeModels(
  api: OpperApi,
): Promise<Record<string, OpenCodeModel> | null> {
  try {
    const res = await api.get<{ data?: CompatModel[] }>("/v3/compat/models");
    const models = toOpenCodeModels(res.data ?? []);
    return Object.keys(models).length > 0 ? models : null;
  } catch {
    return null;
  }
}
