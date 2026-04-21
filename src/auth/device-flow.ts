import { OpperLogin } from "@opperai/login";
import type { AuthSlot } from "./config.js";

// Public OAuth client for the CLI.
const CLIENT_ID = "opper_app_CK-rOJsIIPXlzYYE7MWFCQ";

export interface DevicePrompt {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
}

export interface RunDeviceFlowOptions {
  baseUrl?: string;
  onPrompt?: (p: DevicePrompt) => void;
}

export async function runDeviceFlow(
  opts: RunDeviceFlowOptions = {},
): Promise<AuthSlot> {
  const login = new OpperLogin({
    clientId: CLIENT_ID,
    ...(opts.baseUrl ? { opperUrl: opts.baseUrl } : {}),
  });

  const device = await login.startDeviceAuth();
  opts.onPrompt?.({
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    ...(device.verificationUriComplete
      ? { verificationUriComplete: device.verificationUriComplete }
      : {}),
    expiresIn: device.expiresIn,
  });

  const result = await login.pollDeviceToken(device);
  return {
    apiKey: result.apiKey,
    user: result.user,
    obtainedAt: new Date().toISOString(),
    source: "device-flow",
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
  };
}
