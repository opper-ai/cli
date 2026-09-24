// Managed by @opperai/cli. Remove with `opper editors opencode --remove-login-bridge`.
// OpenCode loads this file at startup; it never writes an API key to OpenCode config.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const FALLBACK_CONTEXT = 128_000;
const FALLBACK_OUTPUT = 8_192;
const DEFAULT_SLOT = "default";

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
  return route ? `${text} (route)` : text;
}

function price(value) {
  if (value === undefined) return undefined;
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? Math.round(number * 1_000_000 * 1e6) / 1e6 : undefined;
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
        name: label(entry.id), tool_call: true, reasoning: false, attachment: false,
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
    console.warn("Opper credential expired. Run `opper login --renew` and restart OpenCode.");
    return;
  }
  return { apiKey: slot.apiKey, baseUrl: slot.baseUrl };
}

function removeOpper(config) {
  if (config.provider && typeof config.provider === "object") delete config.provider.opper;
  if (typeof config.model === "string" && config.model.startsWith("opper/")) delete config.model;
  if (typeof config.small_model === "string" && config.small_model.startsWith("opper/")) delete config.small_model;
}

export const OpperLoginPlugin = async () => ({
  config: async (config) => {
    const current = await credential();
    if (!current) {
      removeOpper(config);
      return;
    }
    const host = (current.baseUrl || "https://api.opper.ai").replace(/\/$/, "");
    let models;
    try {
      const response = await fetch(`${host}/v3/compat/models`, {
        headers: { Authorization: `Bearer ${current.apiKey}` },
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
    config.provider ??= {};
    config.provider.opper = {
      npm: "@ai-sdk/openai-compatible",
      name: "Opper",
      options: { baseURL: `${host}/v3/compat`, apiKey: current.apiKey },
      models,
      whitelist: Object.keys(models),
    };
    const selected = typeof config.model === "string" && config.model.startsWith("opper/")
      ? config.model.slice("opper/".length) : undefined;
    if (selected && !(selected in models)) delete config.model;
    const small = typeof config.small_model === "string" && config.small_model.startsWith("opper/")
      ? config.small_model.slice("opper/".length) : undefined;
    if (small && !(small in models)) delete config.small_model;
  },
});
