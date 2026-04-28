import { log, autocomplete, isCancel, spinner } from "@clack/prompts";
import { isLaunchable } from "../../agents/types.js";
import { getSlot } from "../../auth/config.js";
import { launchCommand } from "../launch.js";
import { fetchModels, type OpperModel } from "../models.js";
import { brand } from "../../ui/colors.js";
import {
  type AdapterStatus,
  type MenuOptions,
  pickMenuChoice,
  probeAdapters,
  reportError,
} from "./shared.js";

// Cache the model list across opens of the agents menu so the picker is
// instant after the first fetch within a session.
let cachedModels: OpperModel[] | null = null;

export async function agentsMenu(opts: MenuOptions): Promise<void> {
  while (true) {
    const statuses = await probeAdapters();
    const options = statuses.map((s) => {
      let stateLabel: string;
      if (!s.installed) stateLabel = brand.dim("(not installed)");
      else if (!s.configured) stateLabel = brand.dim("(not configured)");
      else stateLabel = brand.accent("(configured)");
      return {
        value: `agent:${s.adapter.name}`,
        label: `${s.adapter.displayName} ${stateLabel}`,
        hint: s.adapter.docsUrl,
      };
    });
    options.push({ value: "back", label: brand.dim("← Back"), hint: "" });

    const choice = await pickMenuChoice("Agents", options);
    if (!choice) return;
    if (!choice.startsWith("agent:")) continue;

    const name = choice.slice("agent:".length);
    const status = statuses.find((s) => s.adapter.name === name);
    if (!status) continue;

    try {
      await agentMenu(status, opts);
    } catch (err) {
      reportError(err);
    }
  }
}

async function agentMenu(initial: AdapterStatus, opts: MenuOptions): Promise<void> {
  let current = initial;

  while (true) {
    const { adapter, installed, configured } = current;

    const options: Array<{ value: string; label: string; hint?: string }> = [];

    if (!installed) {
      options.push({
        value: "docs",
        label: "Show install instructions",
        hint: adapter.docsUrl,
      });
    } else {
      if (isLaunchable(adapter) && configured) {
        options.push({
          value: "launch",
          label: "Launch",
          hint: "Route inference through Opper using the default model",
        });
        options.push({
          value: "launch-with-model",
          label: "Launch with model…",
          hint: "Pick a specific Opper model to launch with",
        });
      }
      options.push({
        value: "configure",
        label: configured ? "Reconfigure" : "Configure",
        hint: configured
          ? "Re-write the Opper integration into the agent's config"
          : "Set up the Opper integration",
      });
      if (configured) {
        options.push({
          value: "uninstall",
          label: "Remove Opper integration",
          hint: "Strip Opper-specific config from the agent (binary stays)",
        });
      }
    }
    options.push({ value: "back", label: brand.dim("← Back") });

    const heading = `${adapter.displayName}${
      installed ? (configured ? " — configured" : " — not configured") : " — not installed"
    }`;
    const choice = await pickMenuChoice(heading, options);
    if (!choice) return;

    try {
      switch (choice) {
        case "launch":
          await launchCommand({ agent: adapter.name, key: opts.key });
          break;
        case "launch-with-model": {
          const model = await pickModel(opts.key);
          if (!model) break;
          await launchCommand({ agent: adapter.name, key: opts.key, model });
          break;
        }
        case "configure": {
          const slot = await getSlot(opts.key);
          await adapter.configure({
            ...(slot?.apiKey ? { apiKey: slot.apiKey } : {}),
          });
          log.success(`${adapter.displayName} configured.`);
          break;
        }
        case "uninstall":
          await adapter.unconfigure();
          log.success(`${adapter.displayName} integration removed.`);
          break;
        case "docs":
          log.info(`Install ${adapter.displayName}: ${adapter.docsUrl}`);
          break;
      }
    } catch (err) {
      reportError(err);
    }

    const fresh = await probeAdapters();
    const found = fresh.find((s) => s.adapter.name === adapter.name);
    if (found) current = found;
  }
}

/**
 * Fetch the Opper model catalog (cached for the session) and ask the user
 * to pick one via clack's autocomplete prompt — typing "opus" filters to
 * Claude Opus models, "gpt" to OpenAI, etc. Returns the model id, or null
 * on cancel / when the catalog is empty.
 */
async function pickModel(key: string): Promise<string | null> {
  if (!cachedModels) {
    const s = spinner();
    s.start("Fetching available models");
    try {
      cachedModels = await fetchModels(key);
    } catch (err) {
      s.stop("Failed to fetch models");
      reportError(err);
      return null;
    }
    s.stop(`Loaded ${cachedModels.length} models`);
  }
  if (cachedModels.length === 0) return null;

  const options = cachedModels.map((m) => {
    const opt: { value: string; label: string; hint?: string } = {
      value: m.id,
      label: m.name ? `${m.name}` : m.id,
    };
    const hintParts: string[] = [m.id];
    if (m.context_window) hintParts.push(`${(m.context_window / 1000).toFixed(0)}K ctx`);
    opt.hint = hintParts.join(" · ");
    return opt;
  });

  const result = await autocomplete({
    message: "Select a model (type to filter)",
    options,
    placeholder: "opus, sonnet, gpt, gemini…",
  });
  if (isCancel(result)) return null;
  return typeof result === "string" ? result : null;
}
