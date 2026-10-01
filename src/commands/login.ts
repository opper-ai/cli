import { intro, outro, note, spinner, log, isCancel, cancel } from "@clack/prompts";
import { runDeviceFlow } from "../auth/device-flow.js";
import { getSlot, isSlotExpired, replaceSlotIfUnchanged } from "../auth/config.js";
import { OpperError } from "../errors.js";
import { maybeMigrateLegacyConfig } from "../auth/migrate.js";
import { legacyConfigPath } from "../auth/paths.js";
import { brand } from "../ui/colors.js";
import { openBrowser } from "../util/open-browser.js";
import { validateProjectUuid } from "../api/resolve.js";

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
    if (existing && !opts.renew && !isSlotExpired(existing)) {
      if (opts.projectUuid !== undefined) {
        const replacement = { ...existing, defaultProjectUuid: opts.projectUuid };
        if (!await replaceSlotIfUnchanged(opts.key, existing, replacement)) {
          throw new OpperError("API_ERROR", "The stored credential changed while setting its resource default. Retry.");
        }
      }
      const who = existing.user ? ` as ${existing.user.email}` : "";
      log.success(`Already signed in${who}. Use --renew to replace this key, or --force to re-authenticate.`);
      return;
    }
  }

  const renew = Boolean(opts.renew || (existing && isSlotExpired(existing)));
  // Use the same host for browser approval and the inference request that
  // follows a launch. An explicit --base-url still has highest precedence.
  const baseUrl = opts.baseUrl ?? process.env.OPPER_BASE_URL ?? existing?.baseUrl;

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
