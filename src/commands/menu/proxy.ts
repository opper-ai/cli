import {
  desktopOpenCommand,
  desktopStatusCommand,
  desktopClearCommand,
  desktopStopCommand,
} from "../desktop.js";
import { brand } from "../../ui/colors.js";
import { pickMenuChoice, reportError, type MenuOptions } from "./shared.js";

export async function proxyMenu(opts: MenuOptions): Promise<void> {
  while (true) {
    const choice = await pickMenuChoice("Proxy", [
      { value: "open", label: "Start / open session picker", hint: "Choose a project session for Claude and Codex" },
      { value: "status", label: "Status", hint: "Show the active session and local endpoint" },
      { value: "clear", label: "End session", hint: "Pause new inference until a session is selected" },
      { value: "stop", label: "Stop proxy", hint: "Stop the local service; keep saved sessions" },
      { value: "back", label: brand.dim("← Back") },
    ]);
    if (!choice) return;

    try {
      switch (choice) {
        case "open":
          await desktopOpenCommand({ key: opts.key, ...(opts.projectUuid !== undefined ? { projectUuid: opts.projectUuid } : {}) });
          break;
        case "status":
          await desktopStatusCommand({});
          break;
        case "clear":
          await desktopClearCommand({});
          break;
        case "stop":
          await desktopStopCommand({});
          break;
      }
    } catch (err) {
      reportError(err);
    }
  }
}
