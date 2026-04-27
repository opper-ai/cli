import { intro, outro, select, isCancel, cancel, log } from "@clack/prompts";
import { listAdapters } from "../agents/registry.js";
import { getSlot } from "../auth/config.js";
import { OpperError } from "../errors.js";
import { loginCommand } from "./login.js";
import { logoutCommand } from "./logout.js";
import { whoamiCommand } from "./whoami.js";
import { launchCommand } from "./launch.js";
import { setupCommand } from "./setup.js";
import { skillsListCommand } from "./skills.js";
import { brand } from "../ui/colors.js";
import type { AgentAdapter } from "../agents/types.js";

export interface MenuOptions {
  key: string;
}

interface AdapterStatus {
  adapter: AgentAdapter;
  installed: boolean;
  configured: boolean;
}

async function probeAdapters(): Promise<AdapterStatus[]> {
  return Promise.all(
    listAdapters().map(async (adapter) => {
      let installed = false;
      let configured = false;
      try {
        installed = (await adapter.detect()).installed;
      } catch {
        /* leave false */
      }
      try {
        configured = await adapter.isConfigured();
      } catch {
        /* leave false */
      }
      return { adapter, installed, configured };
    }),
  );
}

function reportError(err: unknown): void {
  if (err instanceof OpperError) {
    log.error(`[${err.code}] ${err.message}${err.hint ? ` — ${err.hint}` : ""}`);
  } else {
    log.error(err instanceof Error ? err.message : String(err));
  }
}

export async function menuCommand(opts: MenuOptions): Promise<void> {
  intro(brand.purple("Opper"));

  while (true) {
    const [slot, statuses] = await Promise.all([
      getSlot(opts.key),
      probeAdapters(),
    ]);

    const options: Array<{ value: string; label: string; hint: string }> = [];

    // Launch entries: only for launchable adapters that are installed AND
    // configured. Hermes counts as configured iff installed (auto-config at
    // launch). OpenCode counts as configured iff its config has the Opper
    // provider block.
    for (const s of statuses) {
      if (!s.adapter.launchable) continue;
      if (!s.installed || !s.configured) continue;
      options.push({
        value: `launch:${s.adapter.name}`,
        label: `Launch ${s.adapter.displayName}`,
        hint: "Route inference through Opper",
      });
    }

    options.push({
      value: "agents",
      label: "Agents",
      hint: "Configure agents and editor integrations",
    });
    options.push({
      value: "setup",
      label: "Run setup wizard",
      hint: "Skills, editors, and more",
    });
    options.push({
      value: "skills",
      label: "Skills status",
      hint: "Show whether Opper skills are installed",
    });

    if (slot) {
      const email = slot.user?.email ?? opts.key;
      options.push({
        value: "whoami",
        label: `Account: ${email}`,
        hint: "Show slot details",
      });
      options.push({
        value: "logout",
        label: "Sign out",
        hint: "Clear the active slot",
      });
    } else {
      options.push({
        value: "login",
        label: "Sign in to Opper",
        hint: "OAuth device flow",
      });
    }

    options.push({ value: "quit", label: "Quit", hint: "" });

    const choice = (await select({
      message: "What would you like to do?",
      options,
    })) as string | symbol;

    if (isCancel(choice)) {
      cancel("Bye.");
      return;
    }
    if (typeof choice !== "string") continue;
    if (choice === "quit") {
      outro(brand.purple("Bye."));
      return;
    }

    try {
      if (choice.startsWith("launch:")) {
        const agent = choice.slice("launch:".length);
        await launchCommand({ agent, key: opts.key });
        continue;
      }
      switch (choice) {
        case "agents":
          await agentsMenu(opts);
          break;
        case "setup":
          await setupCommand({ key: opts.key });
          break;
        case "skills":
          await skillsListCommand();
          break;
        case "login":
          await loginCommand({ key: opts.key });
          break;
        case "logout":
          await logoutCommand({ key: opts.key, all: false });
          break;
        case "whoami":
          await whoamiCommand({ key: opts.key });
          break;
        default:
          log.warn(`Unknown choice: ${choice}`);
      }
    } catch (err) {
      reportError(err);
    }
  }
}

async function agentsMenu(opts: MenuOptions): Promise<void> {
  while (true) {
    const [slot, statuses] = await Promise.all([
      getSlot(opts.key),
      probeAdapters(),
    ]);

    const options: Array<{ value: string; label: string; hint: string }> = [];

    for (const s of statuses) {
      const labelBase = `${s.adapter.launchable ? "🚀" : "📝"} ${s.adapter.displayName}`;
      let stateLabel: string;
      let hint: string;
      if (!s.installed) {
        stateLabel = brand.dim("(not installed)");
        hint = `See ${s.adapter.docsUrl} to install`;
      } else if (!s.configured) {
        stateLabel = brand.dim("(not configured)");
        hint = "Press enter to configure";
      } else {
        stateLabel = brand.purple("(configured)");
        hint = s.adapter.launchable
          ? "Press enter to launch"
          : "Press enter to reconfigure";
      }
      options.push({
        value: `agent:${s.adapter.name}`,
        label: `${labelBase} ${stateLabel}`,
        hint,
      });
    }

    options.push({ value: "back", label: brand.dim("← Back"), hint: "" });

    const choice = (await select({
      message: "Agents",
      options,
    })) as string | symbol;

    if (isCancel(choice) || choice === "back") return;
    if (typeof choice !== "string") continue;

    if (!choice.startsWith("agent:")) continue;
    const name = choice.slice("agent:".length);
    const status = statuses.find((s) => s.adapter.name === name);
    if (!status) continue;

    try {
      await handleAgentSelection(status, slot?.apiKey, opts);
    } catch (err) {
      reportError(err);
    }
  }
}

async function handleAgentSelection(
  status: AdapterStatus,
  apiKey: string | undefined,
  opts: MenuOptions,
): Promise<void> {
  const { adapter, installed, configured } = status;

  if (!installed) {
    log.info(`${adapter.displayName} is not installed.`);
    log.info(`See ${adapter.docsUrl} for install instructions.`);
    return;
  }

  if (!configured) {
    log.info(`Configuring ${adapter.displayName}…`);
    await adapter.configure({ ...(apiKey ? { apiKey } : {}) });
    log.success(`${adapter.displayName} configured.`);
    return;
  }

  // Already installed & configured.
  if (adapter.launchable) {
    await launchCommand({ agent: adapter.name, key: opts.key });
  } else {
    log.info(`Reconfiguring ${adapter.displayName}…`);
    await adapter.configure({ ...(apiKey ? { apiKey } : {}) });
    log.success(`${adapter.displayName} reconfigured.`);
  }
}
