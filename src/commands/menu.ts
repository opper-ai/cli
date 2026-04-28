import { select, confirm, outro, isCancel, cancel, log } from "@clack/prompts";
import { isLaunchable } from "../agents/types.js";
import { launchCommand } from "./launch.js";
import { loginCommand } from "./login.js";
import { brand } from "../ui/colors.js";
import { printBanner } from "../ui/banner.js";
import {
  probeAdapters,
  reportError,
  type MenuOptions,
} from "./menu/shared.js";
import { skillsMenu } from "./menu/skills.js";
import { agentsMenu } from "./menu/agents.js";
import { platformMenu } from "./menu/platform.js";
import { accountMenu } from "./menu/account.js";
import { getSlot } from "../auth/config.js";
import { detectLegacyOpperCli } from "../util/legacy-cli.js";

export type { MenuOptions } from "./menu/shared.js";

export async function menuCommand(opts: MenuOptions): Promise<void> {
  printBanner(opts.version);
  warnOnLegacyCli();
  await maybePromptSignIn(opts);

  while (true) {
    const [statuses, slot] = await Promise.all([
      probeAdapters(),
      getSlot(opts.key),
    ]);

    const options: Array<{ value: string; label: string; hint?: string }> = [];

    // Quick-launch shortcuts: only configured launchable agents.
    for (const s of statuses) {
      if (!isLaunchable(s.adapter)) continue;
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
      hint: "Functions, models, indexes, traces, usage",
    });
    options.push({
      value: "account",
      label: "Account",
      hint: slot
        ? `Signed in as ${slot.user?.email ?? opts.key}`
        : "Sign in to Opper",
    });
    options.push({ value: "quit", label: "Quit" });

    // Main menu has explicit "quit" semantics (not "back"). Cancel is also
    // a quit, so we use select() directly rather than the helper that maps
    // "back" → null.
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
        case "account":
          await accountMenu(opts);
          break;
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

function warnOnLegacyCli(): void {
  const legacy = detectLegacyOpperCli();
  if (!legacy) return;
  const detail = legacy.shadowsUs
    ? `is shadowing this CLI on PATH at ${legacy.path}.`
    : `is also installed at ${legacy.path}.`;
  log.warn(
    `Legacy Homebrew opper CLI ${detail}\n  Uninstall it with: brew uninstall opper`,
  );
}

/**
 * Prompt for sign-in on the very first run when no slot exists. Declined or
 * cancelled prompts fall through to the menu so users can still browse
 * skills/agents without authenticating.
 */
async function maybePromptSignIn(opts: MenuOptions): Promise<void> {
  const slot = await getSlot(opts.key);
  if (slot) return;

  const wantsLogin = await confirm({
    message: "You're not signed in to Opper. Sign in now?",
    initialValue: true,
  });
  if (isCancel(wantsLogin) || wantsLogin !== true) return;

  try {
    await loginCommand({ key: opts.key });
  } catch (err) {
    reportError(err);
  }
}
