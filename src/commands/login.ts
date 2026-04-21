import { runDeviceFlow } from "../auth/device-flow.js";
import { getSlot, setSlot } from "../auth/config.js";
import { maybeMigrateLegacyConfig } from "../auth/migrate.js";
import { legacyConfigPath } from "../auth/paths.js";
import { brand } from "../ui/colors.js";

export interface LoginOptions {
  key: string;
  baseUrl?: string;
  force?: boolean;
  /** Override legacy file path (for tests). */
  legacyPath?: string;
}

export async function loginCommand(opts: LoginOptions): Promise<void> {
  if (!opts.force) {
    const migrated = await maybeMigrateLegacyConfig(
      opts.legacyPath ?? legacyConfigPath(),
    );
    if (migrated) {
      console.log(
        brand.dim(
          "Migrated legacy ~/.oppercli into ~/.opper/config.json (one-time).",
        ),
      );
    }
    const existing = await getSlot(opts.key);
    if (existing) {
      const who = existing.user ? ` as ${existing.user.email}` : "";
      console.log(`Already logged in${who}. Use --force to re-authenticate.`);
      return;
    }
  }

  const slot = await runDeviceFlow({
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    onPrompt(p) {
      const url = p.verificationUriComplete ?? p.verificationUri;
      console.log(`\n${brand.bold("Open this URL to sign in:")} ${brand.purple(url)}`);
      console.log(`${brand.bold("And enter the code:")} ${brand.water(p.userCode)}\n`);
      console.log(brand.dim("Waiting for authorization…"));
    },
  });

  await setSlot(opts.key, slot);
  const who = slot.user ? ` as ${slot.user.email}` : "";
  console.log(brand.purple(`✓ Logged in${who}.`));
}
