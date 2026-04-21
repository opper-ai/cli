import { homedir } from "node:os";
import { join } from "node:path";

export function opperHome(): string {
  return process.env.OPPER_HOME ?? join(homedir(), ".opper");
}

export function configPath(): string {
  return join(opperHome(), "config.json");
}

export function backupsDir(): string {
  return join(opperHome(), "backups");
}

export function legacyConfigPath(): string {
  return join(homedir(), ".oppercli");
}
