import { readConfig } from "../auth/config.js";
import { OpperError } from "../errors.js";

export type DeploymentName = "main" | "evroc";
export interface Deployment {
  name: DeploymentName;
  apiUrl: string;
  platformUrl: string;
  mcpUrl: string;
}
export const DEPLOYMENTS: Record<DeploymentName, Deployment> = {
  main: { name: "main", apiUrl: "https://api.opper.ai", platformUrl: "https://platform.opper.ai", mcpUrl: "https://api.opper.ai/mcp" },
  evroc: { name: "evroc", apiUrl: "https://api.evroc.on.opper.ai", platformUrl: "https://evroc.on.opper.ai", mcpUrl: "https://api.evroc.on.opper.ai/mcp" },
};

export function getDeployment(name: string): Deployment {
  if (name !== "main" && name !== "evroc") {
    throw new OpperError("INVALID_ARGUMENT", `Unknown deployment "${name}"; choose main or evroc.`, "Choose main or evroc with --deployment (-d).");
  }
  return DEPLOYMENTS[name];
}
export function selectedDeployment(): Deployment | undefined {
  return process.env.OPPER_DEPLOYMENT !== undefined ? getDeployment(process.env.OPPER_DEPLOYMENT) : undefined;
}
export function sameApiUrl(a: string, b: string): boolean {
  try { return new URL(a).href.replace(/\/+$/, "") === new URL(b).href.replace(/\/+$/, ""); }
  catch { throw new OpperError("INVALID_ARGUMENT", "The API base URL must be an absolute URL."); }
}
export function deploymentForApiUrl(url: string): Deployment | undefined {
  return Object.values(DEPLOYMENTS).find((deployment) => sameApiUrl(url, deployment.apiUrl));
}

/** Resolves a deployment before authentication, including fresh browser setup. */
export function resolveDeploymentEndpoint(fallback?: string): string {
  const deployment = selectedDeployment();
  const override = process.env.OPPER_BASE_URL;
  if (deployment && override !== undefined && !sameApiUrl(override, deployment.apiUrl)) {
    throw new OpperError("INVALID_ARGUMENT", "OPPER_BASE_URL conflicts with the selected deployment.", "Unset OPPER_BASE_URL or choose the matching deployment.");
  }
  return deployment?.apiUrl ?? override ?? fallback ?? DEPLOYMENTS.main.apiUrl;
}

/** Select credentials by deployment; a name alone never rebinds a saved key. */
export async function slotNameForSelection(explicitKey?: string): Promise<string> {
  const deployment = selectedDeployment();
  if (explicitKey !== undefined) return explicitKey;
  const config = await readConfig();
  const active = config?.defaultKey ?? "default";
  if (!deployment) return active;
  const matches = Object.entries(config?.keys ?? {}).filter(([, slot]) =>
    sameApiUrl(slot.baseUrl ?? DEPLOYMENTS.main.apiUrl, deployment.apiUrl));
  if (matches.some(([name]) => name === active)) return active;
  if (matches.length === 1) return matches[0]![0];
  if (matches.length > 1) {
    throw new OpperError("INVALID_ARGUMENT", `Several slots belong to deployment "${deployment.name}".`, "Choose --key <slot> or switch with `opper config use <slot>`.");
  }
  if (config?.keys[deployment.name]) {
    throw new OpperError("INVALID_ARGUMENT", `Slot "${deployment.name}" already belongs to another API endpoint.`, "Choose a new --key <slot> for this deployment.");
  }
  return deployment.name;
}
