import {
  outro,
  select,
  text,
  confirm,
  isCancel,
  cancel,
  log,
} from "@clack/prompts";
import { listAdapters } from "../agents/registry.js";
import { getSlot } from "../auth/config.js";
import { OpperError } from "../errors.js";
import { loginCommand } from "./login.js";
import { logoutCommand } from "./logout.js";
import { whoamiCommand } from "./whoami.js";
import { launchCommand } from "./launch.js";
import { callCommand } from "./call.js";
import { modelsListCommand } from "./models.js";
import {
  functionsListCommand,
  functionsGetCommand,
  functionsDeleteCommand,
} from "./functions.js";
import {
  tracesListCommand,
  tracesGetCommand,
  tracesDeleteCommand,
} from "./traces.js";
import {
  indexesListCommand,
  indexesGetCommand,
  indexesCreateCommand,
  indexesDeleteCommand,
  indexesQueryCommand,
} from "./indexes.js";
import { usageListCommand } from "./usage.js";
import { configListCommand } from "./config.js";
import {
  skillsInstallCommand,
  skillsUpdateCommand,
  skillsListCommand,
  skillsUninstallCommand,
} from "./skills.js";
import { brand } from "../ui/colors.js";
import { printBanner } from "../ui/banner.js";
import type { AgentAdapter } from "../agents/types.js";

export interface MenuOptions {
  key: string;
  version?: string;
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

/** Cancellable text prompt that returns the trimmed value, or null on cancel. */
async function ask(message: string, opts: { required?: boolean } = {}): Promise<string | null> {
  const promptOpts = opts.required
    ? {
        message,
        validate: (v: string | undefined) =>
          v && v.trim().length > 0 ? undefined : "Required",
      }
    : { message };
  const value = await text(promptOpts);
  if (isCancel(value)) return null;
  return (value ?? "").trim() || null;
}

async function askConfirm(message: string, initial = false): Promise<boolean> {
  const v = await confirm({ message, initialValue: initial });
  if (isCancel(v)) return false;
  return v === true;
}

// ---------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------

export async function menuCommand(opts: MenuOptions): Promise<void> {
  printBanner(opts.version);

  while (true) {
    const statuses = await probeAdapters();

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
    options.push({
      value: "platform",
      label: "Opper",
      hint: "Account, functions, models, indexes, traces, usage",
    });
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
        case "platform":
          await platformMenu(opts);
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

// ---------------------------------------------------------------------------
// Opper / Platform submenu
// ---------------------------------------------------------------------------

async function platformMenu(opts: MenuOptions): Promise<void> {
  while (true) {
    const slot = await getSlot(opts.key);
    const accountLabel = slot
      ? `Account: ${slot.user?.email ?? opts.key}`
      : "Account: not signed in";

    const choice = (await select({
      message: "Opper",
      options: [
        { value: "account", label: accountLabel, hint: "Sign in / out, list slots" },
        { value: "functions", label: "Functions", hint: "Saved functions in your project" },
        { value: "models", label: "Models", hint: "Available models" },
        { value: "indexes", label: "Indexes", hint: "Knowledge bases" },
        { value: "traces", label: "Traces", hint: "Execution traces" },
        { value: "usage", label: "Usage", hint: "Tokens & cost" },
        { value: "call", label: "Call function…", hint: "Run an Opper function with custom inputs" },
        { value: "back", label: brand.dim("← Back"), hint: "" },
      ],
    })) as string | symbol;

    if (isCancel(choice) || choice === "back") return;
    if (typeof choice !== "string") continue;

    try {
      switch (choice) {
        case "account":
          await accountMenu(opts);
          break;
        case "functions":
          await functionsMenu(opts);
          break;
        case "models":
          await modelsListCommand({ key: opts.key });
          break;
        case "indexes":
          await indexesMenu(opts);
          break;
        case "traces":
          await tracesMenu(opts);
          break;
        case "usage":
          await usageListCommand({ key: opts.key });
          break;
        case "call":
          await callWizard(opts);
          break;
      }
    } catch (err) {
      reportError(err);
    }
  }
}

async function accountMenu(opts: MenuOptions): Promise<void> {
  while (true) {
    const slot = await getSlot(opts.key);
    const options: Array<{ value: string; label: string; hint: string }> = [];

    if (slot) {
      options.push({ value: "show", label: "Show details", hint: "Email, slot, base URL" });
      options.push({ value: "logout", label: "Sign out", hint: `Clear slot "${opts.key}"` });
    } else {
      options.push({ value: "login", label: "Sign in", hint: "OAuth device flow" });
    }
    options.push({ value: "slots", label: "List slots", hint: "All configured slots" });
    options.push({ value: "back", label: brand.dim("← Back"), hint: "" });

    const choice = (await select({
      message: slot
        ? `Account — ${slot.user?.email ?? opts.key}`
        : "Account — not signed in",
      options,
    })) as string | symbol;

    if (isCancel(choice) || choice === "back") return;
    if (typeof choice !== "string") continue;

    try {
      switch (choice) {
        case "show":
          await whoamiCommand({ key: opts.key });
          break;
        case "login":
          await loginCommand({ key: opts.key });
          break;
        case "logout":
          await logoutCommand({ key: opts.key, all: false });
          break;
        case "slots":
          await configListCommand();
          break;
      }
    } catch (err) {
      reportError(err);
    }
  }
}

async function functionsMenu(opts: MenuOptions): Promise<void> {
  while (true) {
    const choice = (await select({
      message: "Functions",
      options: [
        { value: "list", label: "List", hint: "Show all functions" },
        { value: "get", label: "Get…", hint: "Show details of a function" },
        { value: "delete", label: "Delete…", hint: "Delete a function" },
        { value: "back", label: brand.dim("← Back"), hint: "" },
      ],
    })) as string | symbol;

    if (isCancel(choice) || choice === "back") return;
    if (typeof choice !== "string") continue;

    try {
      switch (choice) {
        case "list":
          await functionsListCommand({ key: opts.key });
          break;
        case "get": {
          const name = await ask("Function name", { required: true });
          if (!name) continue;
          await functionsGetCommand({ name, key: opts.key });
          break;
        }
        case "delete": {
          const name = await ask("Function name", { required: true });
          if (!name) continue;
          if (!(await askConfirm(`Delete function "${name}"?`))) continue;
          await functionsDeleteCommand({ name, key: opts.key });
          break;
        }
      }
    } catch (err) {
      reportError(err);
    }
  }
}

async function tracesMenu(opts: MenuOptions): Promise<void> {
  while (true) {
    const choice = (await select({
      message: "Traces",
      options: [
        { value: "list", label: "List", hint: "Recent traces" },
        { value: "get", label: "Get…", hint: "Show a trace by id" },
        { value: "delete", label: "Delete…", hint: "Delete a trace by id" },
        { value: "back", label: brand.dim("← Back"), hint: "" },
      ],
    })) as string | symbol;

    if (isCancel(choice) || choice === "back") return;
    if (typeof choice !== "string") continue;

    try {
      switch (choice) {
        case "list":
          await tracesListCommand({ key: opts.key });
          break;
        case "get": {
          const id = await ask("Trace id", { required: true });
          if (!id) continue;
          await tracesGetCommand({ id, key: opts.key });
          break;
        }
        case "delete": {
          const id = await ask("Trace id", { required: true });
          if (!id) continue;
          if (!(await askConfirm(`Delete trace "${id}"?`))) continue;
          await tracesDeleteCommand({ id, key: opts.key });
          break;
        }
      }
    } catch (err) {
      reportError(err);
    }
  }
}

async function indexesMenu(opts: MenuOptions): Promise<void> {
  while (true) {
    const choice = (await select({
      message: "Indexes",
      options: [
        { value: "list", label: "List", hint: "All knowledge bases" },
        { value: "get", label: "Get…", hint: "Show details of an index" },
        { value: "create", label: "Create…", hint: "New empty index" },
        { value: "delete", label: "Delete…", hint: "Remove an index" },
        { value: "query", label: "Query…", hint: "Semantic search" },
        { value: "back", label: brand.dim("← Back"), hint: "" },
      ],
    })) as string | symbol;

    if (isCancel(choice) || choice === "back") return;
    if (typeof choice !== "string") continue;

    try {
      switch (choice) {
        case "list":
          await indexesListCommand({ key: opts.key });
          break;
        case "get": {
          const name = await ask("Index name", { required: true });
          if (!name) continue;
          await indexesGetCommand({ name, key: opts.key });
          break;
        }
        case "create": {
          const name = await ask("New index name", { required: true });
          if (!name) continue;
          await indexesCreateCommand({ name, key: opts.key });
          break;
        }
        case "delete": {
          const name = await ask("Index name", { required: true });
          if (!name) continue;
          if (!(await askConfirm(`Delete index "${name}"?`))) continue;
          await indexesDeleteCommand({ name, key: opts.key });
          break;
        }
        case "query": {
          const name = await ask("Index name", { required: true });
          if (!name) continue;
          const query = await ask("Query", { required: true });
          if (!query) continue;
          await indexesQueryCommand({ name, query, key: opts.key });
          break;
        }
      }
    } catch (err) {
      reportError(err);
    }
  }
}

async function callWizard(opts: MenuOptions): Promise<void> {
  const name = await ask("Function name", { required: true });
  if (!name) return;
  const instructions = await ask("Instructions / system prompt", { required: true });
  if (!instructions) return;
  const input = await ask("Input", { required: true });
  if (!input) return;
  const model = await ask("Model id (leave empty for default)");

  await callCommand({
    name,
    instructions,
    input,
    key: opts.key,
    ...(model ? { model } : {}),
  });
}
