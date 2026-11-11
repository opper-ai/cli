import { select, isCancel, cancel } from "@clack/prompts";
import { previewLegacyConfig } from "../auth/migrate.js";
import { legacyConfigPath } from "../auth/paths.js";
import { getSlot } from "../auth/config.js";
import {
  DEPLOYMENTS, deploymentForApiUrl, slotNameForSelection,
  type DeploymentName,
} from "../config/deployments.js";
import { loginCommand, migrateLegacyConfigForLogin, validateLoginInputs, type LoginOptions } from "./login.js";

type ManualLoginOptions = Omit<LoginOptions, "key" | "activate" | "deployment"> & { key?: string };

/** Manual entry points opt in to selection; automatic authentication never prompts. */
export async function manualLoginCommand(opts: ManualLoginOptions): Promise<string | undefined> {
  validateLoginInputs(opts);
  const explicit = opts.key !== undefined || opts.baseUrl !== undefined
    || process.env.OPPER_DEPLOYMENT !== undefined || process.env.OPPER_BASE_URL !== undefined;
  if (explicit || !process.stdin.isTTY || !process.stdout.isTTY) {
    if (!opts.force) await migrateLegacyConfigForLogin(opts.legacyPath);
    const key = await slotNameForSelection(opts.key);
    return await loginCommand({ ...opts, key }) ? key : undefined;
  }

  const preview = opts.force ? null : await previewLegacyConfig(opts.legacyPath ?? legacyConfigPath());
  const current = await getSlot() ?? preview?.keys[preview.defaultKey];
  const currentDeployment = current ? deploymentForApiUrl(current.baseUrl ?? DEPLOYMENTS.main.apiUrl) : undefined;
  // Existing custom API roots remain usable without being rebound by this menu.
  if (current && !currentDeployment) {
    if (!opts.force) await migrateLegacyConfigForLogin(opts.legacyPath);
    const key = await slotNameForSelection();
    return await loginCommand({ ...opts, key }) ? key : undefined;
  }
  const name = await chooseDeployment(currentDeployment?.name ?? "main");
  if (name === undefined) {
    cancel("Sign-in cancelled.");
    return undefined;
  }
  const deployment = DEPLOYMENTS[name];
  if (!opts.force) await migrateLegacyConfigForLogin(opts.legacyPath);
  const key = await slotNameForSelection(undefined, deployment);
  return await loginCommand({ ...opts, key, deployment: name }) ? key : undefined;
}

async function chooseDeployment(current: DeploymentName): Promise<DeploymentName | undefined> {
  while (true) {
    const choice = await select({
      message: "Where would you like to sign in?",
      initialValue: current === "evroc" ? "other" : "main",
      options: [
        { value: "main", label: "platform.opper.ai" },
        { value: "other", label: "Other deployment…" },
      ],
    });
    if (isCancel(choice)) return undefined;
    if (choice === "main") return "main";
    const other = await select({
      message: "Choose a deployment",
      initialValue: "evroc",
      options: [
        { value: "evroc", label: "evroc.on.opper.ai" },
        { value: "back", label: "← Back" },
      ],
    });
    if (isCancel(other)) return undefined;
    if (other === "evroc") return "evroc";
  }
}
