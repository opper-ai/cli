import { homedir } from "node:os";
import { join } from "node:path";

function home(): string {
  return process.env.OPPER_EDITOR_HOME ?? homedir();
}

export type Location = "global" | "local";
export type VSCodeChannel = "stable" | "insiders";

export function opencodeConfigPath(location: Location): string {
  return location === "global"
    ? join(home(), ".config", "opencode", "opencode.json")
    : join(process.cwd(), "opencode.json");
}

/**
 * User-scope `settings.json` for either VS Code channel. Honours
 * OPPER_EDITOR_HOME via `home()` so tests / sandbox runs land in a tmp dir.
 *
 * Insiders uses the same layout with a "Code - Insiders" folder name.
 */
export function vscodeUserSettingsPath(channel: VSCodeChannel): string {
  const folder = channel === "insiders" ? "Code - Insiders" : "Code";
  if (process.platform === "darwin") {
    return join(
      home(),
      "Library",
      "Application Support",
      folder,
      "User",
      "settings.json",
    );
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home(), "AppData", "Roaming");
    return join(appData, folder, "User", "settings.json");
  }
  return join(home(), ".config", folder, "User", "settings.json");
}
