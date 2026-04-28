import { log } from "@clack/prompts";
import { isLaunchable } from "../../agents/types.js";
import { getSlot } from "../../auth/config.js";
import { launchCommand } from "../launch.js";
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
      const icon = isLaunchable(s.adapter) ? "🚀" : "📝";
      let stateLabel: string;
      if (!s.installed) stateLabel = brand.dim("(not installed)");
      else if (!s.configured) stateLabel = brand.dim("(not configured)");
      else stateLabel = brand.water("(configured)");
      return {
        value: `agent:${s.adapter.name}`,
        label: `${icon} ${s.adapter.displayName} ${stateLabel}`,
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
          hint: "Route inference through Opper",
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
