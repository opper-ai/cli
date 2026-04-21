import { getAdapter } from "../agents/registry.js";
import { getSlot } from "../auth/config.js";
import { loginCommand } from "./login.js";
import { OpperError } from "../errors.js";
import { brand } from "../ui/colors.js";
import { OPPER_OPENAI_COMPAT_URL } from "../api/compat.js";
import type { OpperRouting } from "../agents/types.js";

const DEFAULT_MODEL = "anthropic/claude-opus-4.7";

export interface LaunchOptions {
  agent: string;
  key: string;
  model?: string;
  install?: boolean;
  passthrough?: string[];
}

export async function launchCommand(opts: LaunchOptions): Promise<number> {
  const adapter = getAdapter(opts.agent);
  if (!adapter) {
    throw new OpperError(
      "AGENT_NOT_FOUND",
      `Unknown agent "${opts.agent}"`,
      "Run `opper agents list` to see supported agents.",
    );
  }

  let slot = await getSlot(opts.key);
  if (!slot) {
    await loginCommand({ key: opts.key });
    slot = await getSlot(opts.key);
    if (!slot) {
      throw new OpperError(
        "AUTH_REQUIRED",
        `No API key stored for slot "${opts.key}"`,
        "Run `opper login` first.",
      );
    }
  }

  const detection = await adapter.detect();
  if (!detection.installed) {
    if (!opts.install) {
      throw new OpperError(
        "AGENT_NOT_FOUND",
        `${adapter.displayName} is not installed`,
        `Run \`opper launch ${adapter.name} --install\` to install it, or visit ${adapter.docsUrl}.`,
      );
    }
    console.log(brand.dim(`Installing ${adapter.displayName}…`));
    await adapter.install();
  }

  const routing: OpperRouting = {
    baseUrl: OPPER_OPENAI_COMPAT_URL,
    apiKey: slot.apiKey,
    model: opts.model ?? DEFAULT_MODEL,
    compatShape: "openai",
  };

  const handle = await adapter.snapshotConfig();
  console.log(brand.dim(`Snapshot saved: ${handle.backupPath}`));

  const restore = async () => {
    try {
      await adapter.restoreConfig(handle);
    } catch (err) {
      console.error(
        `\nFailed to restore ${adapter.displayName} config. Recover manually with:`,
      );
      console.error(`  cp "${handle.backupPath}" "<your live config path>"`);
      throw err;
    }
  };

  await adapter.writeOpperConfig(routing);

  // No custom signal handlers: the child inherits the terminal via
  // stdio: "inherit", so SIGINT/SIGTERM go to it directly. When the child
  // exits, adapter.spawn() returns and we always run restore() in finally.
  let exitCode: number;
  let spawnError: unknown;
  try {
    exitCode = await adapter.spawn(opts.passthrough ?? []);
  } catch (err) {
    spawnError = err;
    throw err;
  } finally {
    try {
      await restore();
    } catch (restoreErr) {
      // If spawn itself errored, preserve that error. The restore failure
      // was already logged by the restore() wrapper with recovery hints.
      if (!spawnError) throw restoreErr;
    }
  }

  return exitCode!;
}
