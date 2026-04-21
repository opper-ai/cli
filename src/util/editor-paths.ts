import { homedir } from "node:os";
import { join } from "node:path";

function home(): string {
  return process.env.OPPER_EDITOR_HOME ?? homedir();
}

export type Location = "global" | "local";

export function opencodeConfigPath(location: Location): string {
  return location === "global"
    ? join(home(), ".config", "opencode", "opencode.json")
    : join(process.cwd(), "opencode.json");
}

export function continueConfigPath(location: Location): string {
  return location === "global"
    ? join(home(), ".continue", "config.yaml")
    : join(process.cwd(), ".continue", "config.yaml");
}
