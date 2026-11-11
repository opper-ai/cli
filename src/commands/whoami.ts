import { getSlot, isSlotExpired } from "../auth/config.js";
import { OpperError } from "../errors.js";
import { brand } from "../ui/colors.js";
import { resolveApiBaseUrl } from "../api/resolve.js";
import { deploymentForApiUrl } from "../config/deployments.js";

export interface WhoamiOptions {
  key: string;
}

export async function whoamiCommand(opts: WhoamiOptions): Promise<void> {
  const baseUrl = await resolveApiBaseUrl(opts.key);
  const deployment = deploymentForApiUrl(baseUrl)?.name ?? "custom";
  if (process.env.OPPER_API_KEY) {
    console.log(`${brand.bold("source:")}  OPPER_API_KEY (overrides stored slots)`);
    console.log(`${brand.bold("api key:")} configured (redacted)`);
    console.log(`${brand.bold("deployment:")} ${deployment}`);
    console.log(`${brand.bold("base url:")} ${baseUrl}`);
    return;
  }
  const slot = await getSlot(opts.key);
  if (!slot) {
    throw new OpperError(
      "AUTH_REQUIRED",
      `No API key stored for slot "${opts.key}"`,
      "Run `opper login` to authenticate.",
    );
  }

  console.log(`${brand.bold("slot:")}    ${opts.key}`);
  if (slot.user) {
    console.log(`${brand.bold("user:")}    ${slot.user.name} <${slot.user.email}>`);
  }
  console.log(`${brand.bold("api key:")} configured (redacted)`);
  if (slot.credentialId) console.log(`${brand.bold("key id:")}  ${slot.credentialId}`);
  if (slot.orgId !== undefined) console.log(`${brand.bold("org id:")}  ${slot.orgId}`);
  if (slot.projectName) console.log(`${brand.bold("project:")} ${slot.projectName}${slot.projectUuid ? ` (${slot.projectUuid})` : ""}`);
  else if (slot.projectUuid) console.log(`${brand.bold("project:")} ${slot.projectUuid}`);
  else if (slot.projectId !== undefined) console.log(`${brand.bold("project:")} ${slot.projectId}`);
  if (slot.orgId !== undefined && !slot.projectId && !slot.projectUuid) console.log(`${brand.bold("scope:")}   organization personal credential`);
  if (slot.defaultProjectUuid) console.log(`${brand.bold("resource project:")} ${slot.defaultProjectUuid}`);
  if (slot.expiresAt) {
    console.log(`${brand.bold("expires:")} ${slot.expiresAt}${isSlotExpired(slot) ? " (expired)" : ""}`);
  }
  console.log(`${brand.bold("deployment:")} ${deployment}`);
  console.log(`${brand.bold("base url:")} ${baseUrl}`);
  if (slot.obtainedAt) {
    console.log(`${brand.bold("since:")}   ${slot.obtainedAt}`);
  }
}
