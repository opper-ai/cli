import {
  intro,
  outro,
  select,
  confirm,
  log,
  isCancel,
  cancel,
} from "@clack/prompts";
import { getSlot } from "../auth/config.js";
import { loginCommand } from "./login.js";
import { skillsInstallCommand } from "./skills.js";
import {
  editorsOpenCodeCommand,
  editorsContinueCommand,
  editorsListCommand,
} from "./editors.js";
import { brand } from "../ui/colors.js";
import { OpperError } from "../errors.js";

export interface SetupOptions {
  key: string;
}

type TopChoice = "skills" | "opencode" | "continue" | "editors-list" | "exit";

function exitIfCancelled(value: unknown): void {
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    process.exit(0);
  }
}

export async function setupCommand(opts: SetupOptions): Promise<void> {
  intro(brand.purple("Opper Setup"));

  const slot = await getSlot(opts.key);
  if (!slot) {
    const wantsLogin = await confirm({
      message: "No API key stored. Run `opper login` now?",
      initialValue: true,
    });
    exitIfCancelled(wantsLogin);
    if (wantsLogin) {
      await loginCommand({ key: opts.key });
    } else {
      log.warn(
        "Continuing without authentication. Some steps will be skipped.",
      );
    }
  } else {
    log.success(`Already logged in as ${slot.user?.email ?? "(unknown)"}.`);
  }

  while (true) {
    const choice = (await select({
      message: "What would you like to set up?",
      options: [
        { value: "skills", label: "Install Opper skills" },
        { value: "opencode", label: "Configure OpenCode" },
        { value: "continue", label: "Configure Continue.dev" },
        { value: "editors-list", label: "List supported editors" },
        { value: "exit", label: "Exit" },
      ],
    })) as TopChoice;
    exitIfCancelled(choice);

    if (choice === "exit") break;

    try {
      if (choice === "skills") await skillsInstallCommand();
      else if (choice === "opencode") {
        await editorsOpenCodeCommand({ location: "global", overwrite: false });
      } else if (choice === "continue") {
        await editorsContinueCommand({
          location: "global",
          overwrite: false,
          key: opts.key,
        });
      } else if (choice === "editors-list") await editorsListCommand();
    } catch (err) {
      if (err instanceof OpperError) {
        log.error(
          `[${err.code}] ${err.message}${err.hint ? ` — ${err.hint}` : ""}`,
        );
      } else {
        log.error(err instanceof Error ? err.message : String(err));
      }
    }
  }

  outro(brand.purple("Done."));
}
