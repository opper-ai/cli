import { log, autocomplete, isCancel, spinner } from "@clack/prompts";
import {
  filterModelsForAdapter,
  isLaunchable,
  type AgentAdapter,
} from "../../agents/types.js";
import { resolveApiContext } from "../../api/resolve.js";
import { OpperError } from "../../errors.js";
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
      if (adapter.install) {
        options.push({
          value: "install",
          label: `Install ${adapter.displayName}`,
          hint: adapter.docsUrl,
        });
      }
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
          value: "remove",
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
          await launchCommand({ agent: adapter.name, key: opts.key, ...(opts.projectUuid ? { projectUuid: opts.projectUuid } : {}) });
          break;
        case "launch-with-model": {
          const model = await pickModel(opts.key, adapter, opts.projectUuid);
          if (!model) break;
          await launchCommand({ agent: adapter.name, key: opts.key, model, ...(opts.projectUuid ? { projectUuid: opts.projectUuid } : {}) });
          break;
        }
        case "configure": {
          const context = await resolveApiContext(opts.key, { projectUuid: opts.projectUuid }).catch((error: unknown) => {
            if (error instanceof OpperError && error.code === "AUTH_REQUIRED") return undefined;
            throw error;
          });
          await adapter.configure({
            keyName: opts.key,
            ...(context ?? { baseUrl: process.env.OPPER_BASE_URL ?? "https://api.opper.ai", ...(opts.projectUuid ? { projectUuid: opts.projectUuid } : {}) }),
          });
          log.success(`${adapter.displayName} configured.`);
          break;
        }
        case "remove":
          await adapter.unconfigure();
          log.success(`${adapter.displayName} integration removed.`);
          break;
        case "install":
          if (!adapter.install) break;
          await adapter.install();
          log.success(`${adapter.displayName} installed.`);
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
 * Fetch the current credential's Opper model catalog and ask the user
 * to pick one via clack's autocomplete prompt — typing "opus" filters to
 * Claude Opus models, "gpt" to OpenAI, etc. Returns the model id, or null
 * on cancel / when the catalog is empty.
 */
async function pickModel(
  key: string,
  adapter: AgentAdapter,
  projectUuid?: string,
): Promise<string | null> {
  let fetchedModels: OpperModel[];
  const s = spinner();
  s.start("Fetching available models");
  try {
    fetchedModels = await fetchModels(key, projectUuid);
  } catch (err) {
    s.stop("Failed to fetch models");
    reportError(err);
    return null;
  }
  s.stop(`Loaded ${fetchedModels.length} models`);
  const models = filterModelsForAdapter(adapter, fetchedModels);
  if (models.length === 0) return null;

  const options = models.map((m) => {
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
