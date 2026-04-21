import { getSlot } from "../auth/config.js";
import { OpperError } from "../errors.js";
import { brand } from "../ui/colors.js";

export interface WhoamiOptions {
  key: string;
}

function fingerprint(apiKey: string): string {
  return apiKey.slice(0, 10) + "…";
}

export async function whoamiCommand(opts: WhoamiOptions): Promise<void> {
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
  console.log(`${brand.bold("api key:")} ${fingerprint(slot.apiKey)}`);
  console.log(`${brand.bold("base url:")} ${slot.baseUrl ?? "https://api.opper.ai"}`);
  if (slot.obtainedAt) {
    console.log(`${brand.bold("since:")}   ${slot.obtainedAt}`);
  }
}
