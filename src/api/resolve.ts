import { getSlot, isSlotExpired, type AuthSlot } from "../auth/config.js";
import { OpperError } from "../errors.js";
import { deploymentForApiUrl, resolveDeploymentEndpoint, sameApiUrl, selectedDeployment, slotNameForSelection } from "../config/deployments.js";

const DEFAULT_BASE_URL = "https://api.opper.ai";

export interface ApiContext {
  apiKey: string;
  baseUrl: string;
  /** Explicit request target, independent of the credential's binding. */
  projectUuid?: string | undefined;
}

export interface ApiScopeOptions {
  projectUuid?: string | undefined;
  useDefaultProject?: boolean;
  requireProject?: boolean;
}

export function validateProjectUuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new OpperError("INVALID_ARGUMENT", "--project-uuid must be a project UUID.");
  }
  return value;
}

/** Resolve setup endpoints without requiring a runtime credential. */
export async function resolveApiBaseUrl(keyName?: string): Promise<string> {
  const slot = process.env.OPPER_API_KEY ? null : await getSlot(await slotNameForSelection(keyName));
  return endpointForSlot(slot);
}

function endpointForSlot(slot: AuthSlot | null): string {
  const baseUrl = resolveDeploymentEndpoint(slot?.baseUrl);
  if (slot && (selectedDeployment() || deploymentForApiUrl(baseUrl)) && !sameApiUrl(slot.baseUrl ?? DEFAULT_BASE_URL, baseUrl)) {
    throw new OpperError("INVALID_ARGUMENT", "The selected credential slot belongs to another deployment.", "Choose a matching --key slot, or run `opper login -d <deployment>`.");
  }
  return baseUrl;
}

export async function resolveApiContext(keyName?: string, opts: ApiScopeOptions = {}): Promise<ApiContext> {
  // An environment key is an independent credential: never combine it with
  // the selected slot's host, expiry, organization, or resource default.
  const name = process.env.OPPER_API_KEY ? keyName ?? "environment" : await slotNameForSelection(keyName);
  const slot = process.env.OPPER_API_KEY ? null : await getSlot(name);
  const apiKey = process.env.OPPER_API_KEY ?? slot?.apiKey;
  const baseUrl = endpointForSlot(slot);

  if (!apiKey) {
    throw new OpperError(
      "AUTH_REQUIRED",
      `No API key for slot "${name}"`,
      "Run `opper login`, or set OPPER_API_KEY in the environment.",
    );
  }
  if (!process.env.OPPER_API_KEY && slot && isSlotExpired(slot)) {
    throw new OpperError(
      "AUTH_EXPIRED",
      `Stored API key for slot "${name}" has expired.`,
      "Run `opper login` to obtain a new credential.",
    );
  }
  const sameHost = !slot || new URL(baseUrl).href.replace(/\/+$/, "") ===
    new URL(slot.baseUrl ?? DEFAULT_BASE_URL).href.replace(/\/+$/, "");
  const projectUuid = opts.projectUuid ?? (opts.useDefaultProject && sameHost ? slot?.defaultProjectUuid : undefined);
  if (projectUuid !== undefined) validateProjectUuid(projectUuid);
  if (opts.requireProject && !projectUuid && slot?.source === "device-flow" &&
      slot.orgId && !slot.projectUuid && !slot.projectId) {
    throw new OpperError("PROJECT_REQUIRED", "This command requires a project.",
      "Pass --project-uuid <uuid>, or set a resource default with `opper config project <slot> <uuid>`.");
  }
  return { apiKey, baseUrl, ...(projectUuid !== undefined ? { projectUuid } : {}) };
}
