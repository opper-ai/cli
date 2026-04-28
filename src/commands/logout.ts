import { deleteSlot, readConfig, writeConfig } from "../auth/config.js";
import { brand } from "../ui/colors.js";

export interface LogoutOptions {
  key: string;
  all: boolean;
  yes?: boolean;
}

export async function logoutCommand(opts: LogoutOptions): Promise<void> {
  const cfg = await readConfig();
  if (!cfg || Object.keys(cfg.keys).length === 0) {
    console.log("Nothing to log out of.");
    return;
  }

  if (opts.all) {
    if (!opts.yes) {
      // Non-interactive environments must pass --yes. Callers from TTY should
      // wrap this with a @clack/prompts confirm(); for unit testing we keep
      // the command itself dependency-free.
      console.log("Pass --yes to confirm clearing every slot.");
      return;
    }
    await writeConfig({ ...cfg, keys: {}, defaultKey: "default" });
    console.log(brand.accent("✓ Logged out of all slots."));
    return;
  }

  if (!(opts.key in cfg.keys)) {
    console.log(`No slot named "${opts.key}" — nothing to do.`);
    return;
  }
  await deleteSlot(opts.key);
  console.log(brand.accent(`✓ Logged out of slot "${opts.key}".`));
}
