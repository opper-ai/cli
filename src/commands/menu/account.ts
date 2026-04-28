import { getSlot } from "../../auth/config.js";
import { loginCommand } from "../login.js";
import { logoutCommand } from "../logout.js";
import { whoamiCommand } from "../whoami.js";
import { configListCommand } from "../config.js";
import { brand } from "../../ui/colors.js";
import {
  pickMenuChoice,
  reportError,
  type MenuOptions,
} from "./shared.js";

export async function accountMenu(opts: MenuOptions): Promise<void> {
  while (true) {
    const slot = await getSlot(opts.key);
    const options: Array<{ value: string; label: string; hint?: string }> = [];

    if (slot) {
      options.push({ value: "show", label: "Show details", hint: "Email, slot, base URL" });
      options.push({ value: "logout", label: "Sign out", hint: `Clear slot "${opts.key}"` });
    } else {
      options.push({ value: "login", label: "Sign in", hint: "OAuth device flow" });
    }
    options.push({ value: "slots", label: "List slots", hint: "All configured slots" });
    options.push({ value: "back", label: brand.dim("← Back") });

    const heading = slot
      ? `Account — ${slot.user?.email ?? opts.key}`
      : "Account — not signed in";
    const choice = await pickMenuChoice(heading, options);
    if (!choice) return;

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
