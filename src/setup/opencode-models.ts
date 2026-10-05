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
 * OpenCode merges configured models with its models.dev registry. The config
 * writer also sets a whitelist from this map so registry or older configured
 * models cannot reappear after being removed from the allowed catalog.
 */

import { OpperApi } from "../api/client.js";
import { resolveApiContext, type ApiContext } from "../api/resolve.js";
import { OpperError } from "../errors.js";

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
    reasoning?: { supported: string[]; default?: string };
  };
}

/** An OpenCode `provider.<id>.models.<key>` value; see opencode.ai/config.json. */
export interface OpenCodeModel {
  name: string;
  tool_call: boolean;
  reasoning: boolean;
  options?: Record<string, unknown>;
  variants?: Record<string, Record<string, unknown>>;
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

// Keep in sync with the standalone login plugin; parity is tested. The
// gateway reports a pool's safe intersection, so never infer levels by ID.
const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const MANAGED_VARIANTS = [...REASONING_EFFORTS, "thinking"];

function reasoningOptions(entry: CompatModel): Pick<OpenCodeModel, "options" | "variants"> {
  const metadata = entry.opper?.kind === "dynamic_route" ? undefined : entry.opper?.reasoning;
  const supported = Array.isArray(metadata?.supported) ? metadata.supported : [];
  const variants = Object.fromEntries(MANAGED_VARIANTS.map((effort) => [effort,
    effort !== "thinking" && supported.includes(effort) ? { reasoningEffort: effort } : { disabled: true, opperManagedDisabled: true },
  ]));
  // OpenCode merges its guessed variants with ours. Explicitly disable every
  // unsupported canonical level, even when a model can emit reasoning.
  const defaultEffort = metadata?.default;
  return { variants, ...(defaultEffort && REASONING_EFFORTS.includes(defaultEffort) && supported.includes(defaultEffort)
    ? { options: { reasoningEffort: defaultEffort } } : {}) };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Refresh managed levels without erasing personal variant settings. */
export function preserveOpenCodeVariants(models: Record<string, unknown>, previous: unknown): Record<string, unknown> {
  const oldModels = record(previous);
  return Object.fromEntries(Object.entries(models).map(([id, value]) => {
    const model = record(value);
    const oldModel = record(oldModels?.[id]);
    if (!model || !oldModel) return [id, value];
    const generated = record(model.variants) ?? {};
    const old = record(oldModel.variants) ?? {};
    const supported = Object.values(generated).flatMap((variant) => {
      const v = record(variant);
      return typeof v?.reasoningEffort === "string" && !v.disabled ? [v.reasoningEffort] : [];
    });
    const variants = { ...old, ...generated };
    for (const name of Object.keys(variants)) {
      const fresh = record(generated[name]);
      const saved = record(old[name]);
      if (!saved) continue;
      const { opperManagedDisabled, ...settings } = saved;
      if (opperManagedDisabled === true) delete settings.disabled;
      const invalid = fresh ? Boolean(fresh.disabled) : (settings.reasoningEffort !== undefined &&
        !supported.includes(settings.reasoningEffort as string));
      if (invalid) {
        variants[name] = { ...settings, ...fresh, disabled: true,
          ...(saved.disabled === true && opperManagedDisabled !== true ? {} : { opperManagedDisabled: true }) };
        if (saved.disabled === true && opperManagedDisabled !== true) delete (variants[name] as Record<string, unknown>).opperManagedDisabled;
      } else {
        variants[name] = { ...settings, ...fresh };
      }
    }
    const savedOptions = record(oldModel.options) ?? {};
    const options = { ...savedOptions, ...record(model.options) };
    if (typeof savedOptions.reasoningEffort === "string" && supported.includes(savedOptions.reasoningEffort)) {
      options.reasoningEffort = savedOptions.reasoningEffort;
    }
    if (savedOptions.reasoningEffort !== undefined && !supported.includes(savedOptions.reasoningEffort as string)) {
      delete options.reasoningEffort;
      Object.assign(options, record(model.options));
    }
    return [id, { ...model, ...(Object.keys(options).length ? { options } : {}), variants }];
  }));
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

/** Keep deployment IDs visible without changing labels for other adapters. */
export function pickerDisplayName(id: string): string {
  if (id.startsWith("dynamic/")) return displayName(id);
  return id.includes("/") ? `${displayName(id)} · ${id}` : `${displayName(id)} (pool)`;
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
      out[e.id] = routeEntry(e);
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
      name: pickerDisplayName(e.id),
      // Agent mode is unusable without tool calling, and OpenCode trusts this
      // flag rather than probing — a wrong `true` fails mid-session.
      tool_call: caps.includes("tools"),
      reasoning: caps.includes("reasoning") || caps.includes("thinking"),
      ...reasoningOptions(e),
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
function routeEntry(e: CompatModel): OpenCodeModel {
  return {
    name: pickerDisplayName(e.id),
    tool_call: true,
    reasoning: false,
    ...reasoningOptions(e),
    attachment: false,
    cost: { input: 0, output: 0 },
    // The gateway DOES report bounds for a route whose candidates it can all
    // resolve — the floor every branch can honour. Use them; the constants are
    // only for the case where one candidate is opaque server-side.
    limit: {
      context: e.context_length || FALLBACK_CONTEXT,
      output: e.opper?.max_output_tokens || FALLBACK_OUTPUT,
    },
    modalities: { input: ["text"], output: ["text"] },
  };
}

/**
 * Resolve a setup key or use the exact launch credentials. Only setup without
 * credentials uses the bundled template. Authenticated failures propagate
 * before config is written, and an empty allowed catalog remains empty.
 */
export function resolveOpenCodeModels(context: ApiContext): Promise<Record<string, OpenCodeModel>>;
export function resolveOpenCodeModels(key?: string, projectUuid?: string): Promise<Record<string, OpenCodeModel> | undefined>;
export async function resolveOpenCodeModels(contextOrKey: ApiContext | string = "default", projectUuid?: string): Promise<
  Record<string, OpenCodeModel> | undefined
> {
  let context: ApiContext;
  try {
    context = typeof contextOrKey === "string"
      ? await resolveApiContext(contextOrKey, { projectUuid })
      : contextOrKey;
  } catch (error) {
    if (error instanceof OpperError && error.code === "AUTH_REQUIRED") return undefined;
    throw error;
  }
  return fetchOpenCodeModels(new OpperApi(context));
}

export async function fetchOpenCodeModels(
  api: OpperApi,
): Promise<Record<string, OpenCodeModel>> {
  const res = await api.get<{ data?: CompatModel[] }>("/v3/compat/models");
  if (!Array.isArray(res?.data)) {
    throw new OpperError("API_ERROR", "Invalid model catalog response: expected a data array.");
  }
  return toOpenCodeModels(res.data);
}
