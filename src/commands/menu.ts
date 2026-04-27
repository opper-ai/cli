import { intro, outro, select, isCancel, cancel, log } from "@clack/prompts";
import { listAdapters } from "../agents/registry.js";
import { getSlot } from "../auth/config.js";
import { OpperError } from "../errors.js";
import { loginCommand } from "./login.js";
import { logoutCommand } from "./logout.js";
import { whoamiCommand } from "./whoami.js";
import { launchCommand } from "./launch.js";
import {
  skillsInstallCommand,
  skillsUpdateCommand,
  skillsListCommand,
  skillsUninstallCommand,
} from "./skills.js";
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

    // Quick-launch shortcuts: only configured launchable agents.
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
      hint: "Manage launchable agents and editor integrations",
    });
    options.push({
      value: "skills",
      label: "Skills",
      hint: "Install / update / uninstall Opper skills",
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
        case "skills":
          await skillsMenu();
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

// ---------------------------------------------------------------------------
// Skills submenu
// ---------------------------------------------------------------------------

async function skillsMenu(): Promise<void> {
  while (true) {
    const choice = (await select({
      message: "Skills",
      options: [
        { value: "status", label: "Status", hint: "Show install state" },
        { value: "install", label: "Install", hint: "Copy bundled skills into ~/.claude/skills/" },
        { value: "update", label: "Update", hint: "Re-copy bundled skills (overwrite)" },
        { value: "uninstall", label: "Uninstall", hint: "Remove Opper skills from ~/.claude/skills/" },
        { value: "back", label: brand.dim("← Back"), hint: "" },
      ],
    })) as string | symbol;

    if (isCancel(choice) || choice === "back") return;
    if (typeof choice !== "string") continue;

    try {
      switch (choice) {
        case "status":
          await skillsListCommand();
          break;
        case "install":
          await skillsInstallCommand();
          break;
        case "update":
          await skillsUpdateCommand();
          break;
        case "uninstall":
          await skillsUninstallCommand();
          break;
      }
    } catch (err) {
      reportError(err);
    }
  }
}

// ---------------------------------------------------------------------------
// Agents submenu (and per-agent action submenu)
// ---------------------------------------------------------------------------

async function agentsMenu(opts: MenuOptions): Promise<void> {
  while (true) {
    const statuses = await probeAdapters();
    const options: Array<{ value: string; label: string; hint: string }> = [];

    for (const s of statuses) {
      const icon = s.adapter.launchable ? "🚀" : "📝";
      let stateLabel: string;
      if (!s.installed) stateLabel = brand.dim("(not installed)");
      else if (!s.configured) stateLabel = brand.dim("(not configured)");
      else stateLabel = brand.purple("(configured)");

      options.push({
        value: `agent:${s.adapter.name}`,
        label: `${icon} ${s.adapter.displayName} ${stateLabel}`,
        hint: s.adapter.docsUrl,
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
      await agentMenu(status, opts);
    } catch (err) {
      reportError(err);
    }
  }
}

async function agentMenu(
  initial: AdapterStatus,
  opts: MenuOptions,
): Promise<void> {
  let current = initial;

  while (true) {
    const { adapter, installed, configured } = current;

    const options: Array<{ value: string; label: string; hint: string }> = [];

    if (!installed) {
      options.push({
        value: "docs",
        label: "Show install instructions",
        hint: adapter.docsUrl,
      });
    } else {
      if (adapter.launchable && configured) {
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

    options.push({ value: "back", label: brand.dim("← Back"), hint: "" });

    const choice = (await select({
      message: `${adapter.displayName}${
        installed ? (configured ? " — configured" : " — not configured") : " — not installed"
      }`,
      options,
    })) as string | symbol;

    if (isCancel(choice) || choice === "back") return;
    if (typeof choice !== "string") continue;

    try {
      switch (choice) {
        case "launch":
          // launchCommand handles login auto-trigger and the snapshot/restore flow.
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

    // Re-probe so the menu reflects new state on the next iteration.
    const fresh = await probeAdapters();
    const found = fresh.find((s) => s.adapter.name === adapter.name);
    if (found) current = found;
  }
}
