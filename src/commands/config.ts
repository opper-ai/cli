import {
  setSlot,
  getSlot,
  deleteSlot,
  readConfig,
  replaceSlotIfUnchanged,
} from "../auth/config.js";
import { OpperError } from "../errors.js";
import { brand } from "../ui/colors.js";
import { validateProjectUuid } from "../api/resolve.js";

export async function configProjectCommand(name: string, projectUuid?: string): Promise<void> {
  if (projectUuid !== undefined) validateProjectUuid(projectUuid);
  const slot = await getSlot(name);
  if (!slot) throw new OpperError("AUTH_REQUIRED", `No slot named "${name}"`, "Run `opper login` first.");
  const replacement = { ...slot };
  delete replacement.defaultProjectUuid;
  if (projectUuid !== undefined) replacement.defaultProjectUuid = projectUuid;
  if (!await replaceSlotIfUnchanged(name, slot, replacement)) {
    throw new OpperError("API_ERROR", "The slot changed while setting its resource default. Retry the command.");
  }
  console.log(projectUuid ? `Resource commands for slot "${name}" default to project ${projectUuid}.` : `Cleared the resource project default for slot "${name}".`);
}

export interface ConfigAddOptions {
  name: string;
  apiKey: string;
  baseUrl?: string;
}

export interface ConfigGetOptions {
  name: string;
}

export interface ConfigRemoveOptions {
  name: string;
}

function fingerprint(key: string): string {
  if (key.length <= 10) return "********";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export async function configAddCommand(opts: ConfigAddOptions): Promise<void> {
  await setSlot(opts.name, {
    apiKey: opts.apiKey,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    source: "manual",
    obtainedAt: new Date().toISOString(),
  });
  console.log(brand.accent(`✓ Stored API key for slot "${opts.name}".`));
}

export async function configListCommand(): Promise<void> {
  const cfg = await readConfig();
  if (!cfg || Object.keys(cfg.keys).length === 0) {
    console.log("(no slots configured)");
    return;
  }
  for (const [name, slot] of Object.entries(cfg.keys)) {
    const marker = name === cfg.defaultKey ? brand.accent("*") : " ";
    console.log(`${marker} ${name.padEnd(14)} ${fingerprint(slot.apiKey)}`);
  }
}

export async function configGetCommand(opts: ConfigGetOptions): Promise<void> {
  const slot = await getSlot(opts.name);
  if (!slot) {
    throw new OpperError(
      "AUTH_REQUIRED",
      `No slot named "${opts.name}"`,
      "Run `opper config add <name> <api-key>` or `opper login --key <name>`.",
    );
  }
  process.stdout.write(`${slot.apiKey}\n`);
}

export async function configRemoveCommand(
  opts: ConfigRemoveOptions,
): Promise<void> {
  await deleteSlot(opts.name);
  console.log(brand.accent(`✓ Removed slot "${opts.name}".`));
}
