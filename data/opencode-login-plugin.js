// Managed by @opperai/cli. Remove with `opper editors opencode --remove-login-bridge`.
// OpenCode loads this file at startup; it never writes an API key to OpenCode config.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const FALLBACK_CONTEXT = 128_000;
const FALLBACK_OUTPUT = 8_192;
const DEFAULT_SLOT = "default";
const DEFAULT_PROJECT_UUID = undefined;

function expired(value) {
  if (!value) return false;
  const time = Date.parse(value);
  return !Number.isFinite(time) || time <= Date.now();
}

function label(id) {
  const route = id.startsWith("dynamic/");
  const name = route ? id.slice(8) : id.slice(id.lastIndexOf("/") + 1);
  const text = name.split(/[-_]/).map((word) =>
    /^[0-9]/.test(word) || word.length <= 2 ? word : word[0].toUpperCase() + word.slice(1),
  ).join(" ");
  return route ? `${text} (route)` : id.includes("/") ? `${text} · ${id}` : `${text} (pool)`;
}

function price(value) {
  if (value === undefined) return undefined;
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? Math.round(number * 1_000_000 * 1e6) / 1e6 : undefined;
}

const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const MANAGED_VARIANTS = [...REASONING_EFFORTS, "thinking"];

function reasoningOptions(entry) {
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

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value : undefined;
}

/** Selected provider credentials/routing must take precedence over saved settings. */
function compatibleOpenCodeSettings(value) {
  return Object.fromEntries(Object.entries(record(value) ?? {}).flatMap(([name, setting]) => {
    if (["apikey", "baseurl"].includes(name.toLowerCase())) return [];
    if (name === "headers") {
      const headers = Object.fromEntries(Object.entries(record(setting) ?? {}).filter(([header]) =>
        !["authorization", "x-opper-project"].includes(header.toLowerCase())));
      return Object.keys(headers).length ? [[name, headers]] : [];
    }
    return [[name, ["options", "settings"].includes(name) ? compatibleOpenCodeSettings(setting) : setting]];
  }));
}

/** Refresh managed levels without erasing personal variant settings. */
function preserveOpenCodeVariants(models, previous) {
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
      if (!record(old[name])) continue;
      const saved = compatibleOpenCodeSettings(old[name]);
      const { opperManagedDisabled, ...settings } = saved;
      if (opperManagedDisabled === true) delete settings.disabled;
      const invalid = fresh ? Boolean(fresh.disabled) : (settings.reasoningEffort !== undefined &&
        !supported.includes(settings.reasoningEffort));
      if (invalid) {
        variants[name] = { ...settings, ...fresh, disabled: true,
          ...(saved.disabled === true && opperManagedDisabled !== true ? {} : { opperManagedDisabled: true }) };
        if (saved.disabled === true && opperManagedDisabled !== true) delete (variants[name]).opperManagedDisabled;
      } else {
        variants[name] = { ...settings, ...fresh };
      }
    }
    const savedOptions = compatibleOpenCodeSettings(oldModel.options);
    const options = { ...savedOptions, ...record(model.options) };
    if (typeof savedOptions.reasoningEffort === "string" && supported.includes(savedOptions.reasoningEffort)) {
      options.reasoningEffort = savedOptions.reasoningEffort;
    }
    if (savedOptions.reasoningEffort !== undefined && !supported.includes(savedOptions.reasoningEffort)) {
      delete options.reasoningEffort;
      Object.assign(options, record(model.options));
    }
    return [id, { ...model, ...(Object.keys(options).length ? { options } : {}), variants }];
  }));
}

function modelsFromCatalog(entries) {
  const models = Object.create(null);
  for (const entry of entries) {
    if (typeof entry?.id !== "string" || !entry.id) continue;
    const type = entry.opper?.type ?? "llm";
    const route = entry.opper?.kind === "dynamic_route";
    if (type !== "llm" && !route) continue;
    const context = entry.context_length || FALLBACK_CONTEXT;
    const output = entry.opper?.max_output_tokens || FALLBACK_OUTPUT;
    if (route) {
      models[entry.id] = {
        name: label(entry.id), tool_call: true, reasoning: false, ...reasoningOptions(entry), attachment: false,
        cost: { input: 0, output: 0 }, limit: { context, output },
        modalities: { input: ["text"], output: ["text"] },
      };
      continue;
    }
    const input = price(entry.pricing?.prompt);
    const completion = price(entry.pricing?.completion);
    if (input === undefined || completion === undefined) continue;
    const caps = entry.opper?.capabilities ?? [];
    const cacheRead = price(entry.pricing?.input_cache_read);
    const cacheWrite = price(entry.pricing?.input_cache_write);
    const inputModes = ["text"];
    if (caps.includes("vision")) inputModes.push("image");
    if (caps.includes("pdf")) inputModes.push("pdf");
    models[entry.id] = {
      name: label(entry.id),
      tool_call: caps.includes("tools"),
      reasoning: caps.includes("reasoning") || caps.includes("thinking"),
      ...reasoningOptions(entry),
      attachment: caps.includes("vision") || caps.includes("pdf"),
      cost: {
        input, output: completion,
        ...(cacheRead !== undefined ? { cache_read: cacheRead } : {}),
        ...(cacheWrite !== undefined ? { cache_write: cacheWrite } : {}),
      },
      limit: { context, output },
      modalities: { input: inputModes, output: ["text"] },
    };
  }
  return models;
}

async function credential() {
  const projectUuid = process.env.OPPER_PROJECT_UUID || (!process.env.OPPER_API_KEY ? DEFAULT_PROJECT_UUID : undefined);
  if (projectUuid && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectUuid)) {
    console.warn("Invalid Opper project UUID. Reconfigure the login bridge or set OPPER_PROJECT_UUID to a project UUID.");
    return;
  }
  if (process.env.OPPER_API_KEY) {
    return { apiKey: process.env.OPPER_API_KEY, baseUrl: process.env.OPPER_BASE_URL, projectUuid };
  }
  let slot;
  try {
    const root = process.env.OPPER_EDITOR_HOME || homedir();
    const config = JSON.parse(await readFile(join(process.env.OPPER_HOME || join(root, ".opper"), "config.json"), "utf8"));
    // The CLI's unqualified commands use the literal `default` slot, even if
    // config.defaultKey points at the first (differently named) slot created.
    slot = config.keys?.[process.env.OPPER_KEY_SLOT || DEFAULT_SLOT];
  } catch {
    // A missing or invalid CLI config is equivalent to no selected credential.
  }
  if (!slot || typeof slot.apiKey !== "string" || !slot.apiKey) return;
  if (expired(slot.expiresAt)) {
    console.warn("Opper credential expired. Renew the selected CLI slot with `opper --key <slot> login --renew` and restart OpenCode.");
    return;
  }
  return { apiKey: slot.apiKey, baseUrl: process.env.OPPER_BASE_URL || slot.baseUrl, projectUuid };
}

function removeOpper(config) {
  if (config.provider && typeof config.provider === "object") delete config.provider.opper;
  if (typeof config.model === "string" && config.model.startsWith("opper/")) delete config.model;
  if (typeof config.small_model === "string" && config.small_model.startsWith("opper/")) delete config.small_model;
}

export const OpperLoginPlugin = async () => {
  let policy;
  return {
    config: async (config) => {
      // `opper launch opencode` provides a session URL and its selected key in
      // OPENCODE_CONFIG_CONTENT. Its runtime route must take precedence over the
      // persistent plain-OpenCode bridge.
      if (process.env.OPPER_CLI_LAUNCH_OPENCODE === "1") {
        // Launch owns routing/authentication; use its exact discovered policy.
        if (process.env.OPPER_CLI_EFFORT_POLICY) {
          policy = JSON.parse(await readFile(process.env.OPPER_CLI_EFFORT_POLICY, "utf8"));
        }
        return;
      }
      const current = await credential();
      if (!current) {
        removeOpper(config);
        return;
      }
      const host = (current.baseUrl || "https://api.opper.ai").replace(/\/$/, "");
      let models;
      try {
        const response = await fetch(`${host}/v3/compat/models`, {
          headers: { Authorization: `Bearer ${current.apiKey}`, ...(current.projectUuid ? { "X-Opper-Project": current.projectUuid } : {}) },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error("catalog unavailable");
        const body = await response.json();
        if (!Array.isArray(body?.data)) throw new Error("invalid catalog");
        models = modelsFromCatalog(body.data);
        if (Object.keys(models).length === 0) throw new Error("empty catalog");
      } catch {
        // Keep unrelated OpenCode providers usable. The gateway still enforces
        // access, but stale model lists should not appear to be current policy.
        removeOpper(config);
        console.warn("Opper model catalog unavailable. Check the connection or renew the key, then restart OpenCode.");
        return;
      }
      policy = models;
      config.provider ??= {};
      config.provider.opper = {
        npm: "@ai-sdk/openai-compatible",
        name: "Opper",
        options: { baseURL: `${host}/v3/compat`, apiKey: current.apiKey,
          ...(current.projectUuid ? { headers: { "X-Opper-Project": current.projectUuid } } : {}) },
        models: preserveOpenCodeVariants(models, config.provider.opper?.models),
        whitelist: Object.keys(models),
      };
      const selected = typeof config.model === "string" && config.model.startsWith("opper/")
        ? config.model.slice("opper/".length) : undefined;
      if (selected && !(selected in models)) delete config.model;
      const small = typeof config.small_model === "string" && config.small_model.startsWith("opper/")
        ? config.small_model.slice("opper/".length) : undefined;
      if (small && !(small in models)) delete config.small_model;
    },
    "chat.params": async ({ model }, output) => {
      if (model.providerID !== "opper" || !policy) return;
      const effort = output.options.reasoningEffort;
      const supported = Object.values(policy[model.id]?.variants ?? {}).some((variant) =>
        !variant.disabled && variant.reasoningEffort === effort);
      // OpenCode guesses medium from GPT IDs after config merging. Deleting the
      // unsupported option here lets the gateway/model choose its own default.
      if (effort !== undefined && !supported) delete output.options.reasoningEffort;
    },
  };
};
