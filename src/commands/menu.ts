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
import { editorsListCommand } from "./editors.js";
import { brand } from "../ui/colors.js";

export interface MenuOptions {
  key: string;
}

interface AdapterStatus {
  name: string;
  displayName: string;
  installed: boolean;
}

async function detectAdapters(): Promise<AdapterStatus[]> {
  return Promise.all(
    listAdapters().map(async (a) => {
      try {
        const r = await a.detect();
        return {
          name: a.name,
          displayName: a.displayName,
          installed: r.installed,
        };
      } catch {
        return { name: a.name, displayName: a.displayName, installed: false };
      }
    }),
  );
}

export async function menuCommand(opts: MenuOptions): Promise<void> {
  intro(brand.purple("Opper"));

  while (true) {
    // Re-detect each iteration so install state stays fresh between actions.
    const [slot, adapters] = await Promise.all([
      getSlot(opts.key),
      detectAdapters(),
    ]);

    const options: Array<{ value: string; label: string; hint: string }> = [];

    for (const a of adapters) {
      const suffix = a.installed ? "" : ` ${brand.dim("(not installed)")}`;
      options.push({
        value: `launch:${a.name}`,
        label: `Launch ${a.displayName}${suffix}`,
        hint: a.installed
          ? "Route inference through Opper"
          : `Run \`opper launch ${a.name} --install\` to install`,
      });
    }

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
    options.push({
      value: "editors",
      label: "Editor integrations",
      hint: "List supported AI editors",
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
        case "setup":
          await setupCommand({ key: opts.key });
          break;
        case "skills":
          await skillsListCommand();
          break;
        case "editors":
          await editorsListCommand();
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
      // An action failed — show the error and return to the menu rather than
      // tearing the whole CLI down. Critical errors still propagate via
      // OpperError to top-level when launched non-interactively.
      if (err instanceof OpperError) {
        log.error(`[${err.code}] ${err.message}${err.hint ? ` — ${err.hint}` : ""}`);
      } else {
        log.error(err instanceof Error ? err.message : String(err));
      }
    }
  }
}
