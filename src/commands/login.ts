import { intro, outro, note, spinner, log, isCancel, cancel } from "@clack/prompts";
import { runDeviceFlow } from "../auth/device-flow.js";
import { getSlot, isSlotExpired, replaceSlotIfUnchanged, setDefaultSlot, assertInactiveSlotCreation } from "../auth/config.js";
import { OpperError } from "../errors.js";
import { maybeMigrateLegacyConfig } from "../auth/migrate.js";
import { legacyConfigPath } from "../auth/paths.js";
import { brand } from "../ui/colors.js";
import { openBrowser } from "../util/open-browser.js";
import { validateProjectUuid } from "../api/resolve.js";
import { DEPLOYMENTS, deploymentForApiUrl, resolveDeploymentEndpoint, sameApiUrl, selectedDeployment, getDeployment, type DeploymentName } from "../config/deployments.js";

export interface LoginOptions {
  key: string;
  /** Explicit choice from the manual sign-in menu; never changes process environment. */
  deployment?: DeploymentName;
  baseUrl?: string;
  force?: boolean;
  renew?: boolean;
  /** Automatic authentication must not change the saved active profile. */
  activate?: boolean;
  projectUuid?: string | undefined;
  /** Override legacy file path (for tests). */
  legacyPath?: string;
}

export async function loginCommand(opts: LoginOptions): Promise<boolean> {
  const deployment = validateLoginInputs(opts);
  let existing = await getSlot(opts.key);
  if (!opts.force) {
    await migrateLegacyConfigForLogin(opts.legacyPath);
    existing = await getSlot(opts.key);
  }
  const baseUrl = opts.baseUrl ?? resolveDeploymentEndpoint(existing?.baseUrl, deployment);
  sameApiUrl(baseUrl, baseUrl); // Validate explicit empty or malformed roots before starting OAuth.
  const existingMatches = !existing || sameApiUrl(existing.baseUrl ?? "https://api.opper.ai", baseUrl);
  if (deployment && !existingMatches) {
    throw new OpperError("INVALID_ARGUMENT", `Slot "${opts.key}" belongs to another deployment.`, "Choose a new --key slot or omit --key to select a matching slot automatically.");
  }
  // Creating a non-main credential in a missing default slot would change
  // unqualified commands even if the default slot name itself stayed the same.
  const rejectDefaultSlotCreation = opts.activate === false && !sameApiUrl(baseUrl, DEPLOYMENTS.main.apiUrl);
  if (rejectDefaultSlotCreation) await assertInactiveSlotCreation(opts.key);
  if (!opts.force) {
    if (existing && existingMatches && !opts.renew && !isSlotExpired(existing)) {
      if (opts.projectUuid !== undefined) {
        const replacement = { ...existing, defaultProjectUuid: opts.projectUuid };
        if (!await replaceSlotIfUnchanged(opts.key, existing, replacement)) {
          throw new OpperError("API_ERROR", "The stored credential changed while setting its resource default. Retry.");
        }
      }
      if (deployment && opts.activate !== false) await setDefaultSlot(opts.key);
      const who = existing.user ? ` as ${existing.user.email}` : "";
      log.success(`Already signed in${who}. Use --renew to replace this key, or --force to re-authenticate.`);
      return true;
    }
  }

  // A credential identifier is meaningful only at its issuing API root.
  const renew = Boolean(existingMatches && (opts.renew || (existing && isSlotExpired(existing))));
  intro(brand.accent("Sign in to Opper"));

  const s = spinner();
  let promptShown = false;

  try {
    const slot = await runDeviceFlow({
      ...(baseUrl ? { baseUrl } : {}),
      ...(renew ? { renew: true } : {}),
      ...(renew && existing?.credentialId ? { currentCredentialId: existing.credentialId } : {}),
      onPrompt(p) {
        const url = p.verificationUriComplete ?? p.verificationUri;
        note(
          process.platform === "win32"
            ? `Open this URL in your browser:\n${brand.accent(url)}\nEnter code ${brand.accent(p.userCode)} if requested.`
            : `Opening ${brand.accent(url)} in your browser…\nIf it doesn't open, paste the URL above and enter code ${brand.accent(p.userCode)}`,
          "Authorize the CLI",
        );
        openBrowser(url);
        s.start("Waiting for browser approval");
        promptShown = true;
      },
    });

    slot.baseUrl = baseUrl;
    const profile = deploymentForApiUrl(baseUrl);
    if (profile) slot.deployment = profile.name;

    // Replace all credential metadata. Only a resource preference survives a
    // renewal to the same verified org and API host; old bindings never do.
    const sameOrg = typeof existing?.orgId === "number" && existing.orgId > 0 && existing.orgId === slot.orgId;
    const sameHost = new URL(existing?.baseUrl ?? "https://api.opper.ai").href.replace(/\/+$/, "") ===
      new URL(slot.baseUrl ?? "https://api.opper.ai").href.replace(/\/+$/, "");
    const defaultProjectUuid = opts.projectUuid ?? (sameOrg && sameHost ? existing?.defaultProjectUuid : undefined);
    if (defaultProjectUuid !== undefined) slot.defaultProjectUuid = defaultProjectUuid;

    if (renew && existing && slot.apiKey === existing.apiKey) {
      throw new OpperError(
        "API_ERROR",
        "The server returned the existing API key instead of a replacement.",
        "The stored key was preserved. Check that credential renewal is enabled, then retry.",
      );
    }

    // Browser approval can take minutes. Compare and write under one lock so
    // another process's newer credential cannot be overwritten by this result.
    if (!await replaceSlotIfUnchanged(opts.key, existing, slot, { preserveDefaultKey: opts.activate === false, rejectDefaultSlotCreation })) {
      throw new OpperError(
        "API_ERROR",
        "The stored credential changed while browser approval was in progress.",
        "The newer stored key was preserved. Check `opper whoami` before retrying.",
      );
    }

    if (deployment && opts.activate !== false) await setDefaultSlot(opts.key);
    const who = slot.user ? slot.user.email : opts.key;
    if (promptShown) s.stop(`Signed in as ${who}`);
    else log.success(`Signed in as ${who}`);
    outro(brand.accent("✓"));
    return true;
  } catch (err) {
    if (promptShown) s.stop("Sign-in failed");
    if (isCancel(err)) {
      cancel("Sign-in cancelled.");
      return false;
    }
    throw err;
  }
}


/** Reject explicit routing errors before migration or any other sign-in side effect. */
export function validateLoginInputs(opts: Pick<LoginOptions, "baseUrl" | "deployment" | "projectUuid">) {
  if (opts.projectUuid !== undefined) validateProjectUuid(opts.projectUuid);
  const deployment = opts.deployment !== undefined ? getDeployment(opts.deployment) : selectedDeployment();
  const selectedUrl = opts.baseUrl ?? resolveDeploymentEndpoint(undefined, deployment);
  sameApiUrl(selectedUrl, selectedUrl);
  if (deployment && !sameApiUrl(selectedUrl, deployment.apiUrl)) {
    throw new OpperError("INVALID_ARGUMENT", "--base-url conflicts with the selected deployment.");
  }
  return deployment;
}

/** Share migration and its one-time notice with manual sign-in before resolving a slot. */
export async function migrateLegacyConfigForLogin(path = legacyConfigPath()): Promise<void> {
  if (await maybeMigrateLegacyConfig(path)) {
    log.info("Migrated legacy ~/.oppercli into ~/.opper/config.json (one-time).");
  }
}
