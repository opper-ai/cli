import { intro, outro, note, spinner, log, isCancel, cancel } from "@clack/prompts";
import { runDeviceFlow } from "../auth/device-flow.js";
import { getSlot, isSlotExpired, replaceSlotIfUnchanged, setDefaultSlot } from "../auth/config.js";
import { OpperError } from "../errors.js";
import { maybeMigrateLegacyConfig } from "../auth/migrate.js";
import { legacyConfigPath } from "../auth/paths.js";
import { brand } from "../ui/colors.js";
import { openBrowser } from "../util/open-browser.js";
import { validateProjectUuid } from "../api/resolve.js";
import { deploymentForApiUrl, resolveDeploymentEndpoint, sameApiUrl, selectedDeployment } from "../config/deployments.js";

export interface LoginOptions {
  key: string;
  baseUrl?: string;
  force?: boolean;
  renew?: boolean;
  projectUuid?: string | undefined;
  /** Override legacy file path (for tests). */
  legacyPath?: string;
}

export async function loginCommand(opts: LoginOptions): Promise<void> {
  if (opts.projectUuid !== undefined) validateProjectUuid(opts.projectUuid);
  let existing = await getSlot(opts.key);
  if (!opts.force) {
    const migrated = await maybeMigrateLegacyConfig(
      opts.legacyPath ?? legacyConfigPath(),
    );
    if (migrated) {
      log.info(
        "Migrated legacy ~/.oppercli into ~/.opper/config.json (one-time).",
      );
    }
    existing = await getSlot(opts.key);
  }
  const deployment = selectedDeployment();
  if (deployment && opts.baseUrl && !sameApiUrl(opts.baseUrl, deployment.apiUrl)) {
    throw new OpperError("INVALID_ARGUMENT", "--base-url conflicts with the selected deployment.");
  }
  const baseUrl = opts.baseUrl ?? resolveDeploymentEndpoint(existing?.baseUrl);
  const existingMatches = !existing || sameApiUrl(existing.baseUrl ?? "https://api.opper.ai", baseUrl);
  if (deployment && !existingMatches) {
    throw new OpperError("INVALID_ARGUMENT", `Slot "${opts.key}" belongs to another deployment.`, "Choose a new --key slot or omit --key to select a matching slot automatically.");
  }
  if (!opts.force) {
    if (existing && existingMatches && !opts.renew && !isSlotExpired(existing)) {
      if (opts.projectUuid !== undefined) {
        const replacement = { ...existing, defaultProjectUuid: opts.projectUuid };
        if (!await replaceSlotIfUnchanged(opts.key, existing, replacement)) {
          throw new OpperError("API_ERROR", "The stored credential changed while setting its resource default. Retry.");
        }
      }
      if (deployment) await setDefaultSlot(opts.key);
      const who = existing.user ? ` as ${existing.user.email}` : "";
      log.success(`Already signed in${who}. Use --renew to replace this key, or --force to re-authenticate.`);
      return;
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
    if (!await replaceSlotIfUnchanged(opts.key, existing, slot)) {
      throw new OpperError(
        "API_ERROR",
        "The stored credential changed while browser approval was in progress.",
        "The newer stored key was preserved. Check `opper whoami` before retrying.",
      );
    }

    if (deployment) await setDefaultSlot(opts.key);
    const who = slot.user ? slot.user.email : opts.key;
    if (promptShown) s.stop(`Signed in as ${who}`);
    else log.success(`Signed in as ${who}`);
    outro(brand.accent("✓"));
  } catch (err) {
    if (promptShown) s.stop("Sign-in failed");
    if (isCancel(err)) {
      cancel("Sign-in cancelled.");
      return;
    }
    throw err;
  }
}
