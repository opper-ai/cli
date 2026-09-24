import { intro, outro, note, spinner, log, isCancel, cancel } from "@clack/prompts";
import { runDeviceFlow } from "../auth/device-flow.js";
import { getSlot, isSlotExpired, setSlot } from "../auth/config.js";
import { OpperError } from "../errors.js";
import { maybeMigrateLegacyConfig } from "../auth/migrate.js";
import { legacyConfigPath } from "../auth/paths.js";
import { brand } from "../ui/colors.js";
import { openBrowser } from "../util/open-browser.js";

export interface LoginOptions {
  key: string;
  baseUrl?: string;
  force?: boolean;
  renew?: boolean;
  /** Override legacy file path (for tests). */
  legacyPath?: string;
}

export async function loginCommand(opts: LoginOptions): Promise<void> {
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
      const who = existing.user ? ` as ${existing.user.email}` : "";
      log.success(`Already signed in${who}. Use --renew to replace this key, or --force to re-authenticate.`);
      return;
    }
  }

  const renew = Boolean(opts.renew || (existing && isSlotExpired(existing)));

  intro(brand.accent("Sign in to Opper"));

  const s = spinner();
  let promptShown = false;

  try {
    const slot = await runDeviceFlow({
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
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

    if (renew && existing && slot.apiKey === existing.apiKey) {
      throw new OpperError(
        "API_ERROR",
        "The server returned the existing API key instead of a replacement.",
        "The stored key was preserved. Check that credential renewal is enabled, then retry.",
      );
    }

    await setSlot(opts.key, slot);
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
