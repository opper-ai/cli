import { getSlot, isSlotExpired } from "../auth/config.js";
import { OpperError } from "../errors.js";

const DEFAULT_BASE_URL = "https://api.opper.ai";

export interface ApiContext {
  apiKey: string;
  baseUrl: string;
}

export async function resolveApiContext(keyName: string): Promise<ApiContext> {
  const slot = await getSlot(keyName);
  const apiKey = process.env.OPPER_API_KEY ?? slot?.apiKey;
  const baseUrl =
    process.env.OPPER_BASE_URL ?? slot?.baseUrl ?? DEFAULT_BASE_URL;

  if (!apiKey) {
    throw new OpperError(
      "AUTH_REQUIRED",
      `No API key for slot "${keyName}"`,
      "Run `opper login`, or set OPPER_API_KEY in the environment.",
    );
  }
  if (!process.env.OPPER_API_KEY && slot && isSlotExpired(slot)) {
    throw new OpperError(
      "AUTH_EXPIRED",
      `Stored API key for slot "${keyName}" has expired.`,
      "Run `opper login` to obtain a new credential.",
    );
  }
  return { apiKey, baseUrl };
}
