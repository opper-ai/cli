import { getAdapter } from "../agents/registry.js";
import { isLaunchable } from "../agents/types.js";
import { getSlot } from "../auth/config.js";
import { loginCommand } from "./login.js";
import { OpperError } from "../errors.js";
import { brand } from "../ui/colors.js";
import { OPPER_OPENAI_COMPAT_URL } from "../config/endpoints.js";
import { DEFAULT_MODELS } from "../config/models.js";
import type { OpperRouting } from "../agents/types.js";

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
  if (!isLaunchable(adapter)) {
    throw new OpperError(
      "AGENT_NOT_FOUND",
      `${adapter.displayName} is a configure-only integration and cannot be launched`,
      `Configure it via the agents menu (\`opper\` → Agents → ${adapter.displayName}).`,
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
    if (!adapter.install) {
      throw new OpperError(
        "AGENT_NOT_FOUND",
        `${adapter.displayName} has no scripted installer`,
        `Install manually from ${adapter.docsUrl}.`,
      );
    }
    console.log(brand.dim(`Installing ${adapter.displayName}…`));
    await adapter.install();
  }

  const routing: OpperRouting = {
    baseUrl: OPPER_OPENAI_COMPAT_URL,
    apiKey: slot.apiKey,
    model: opts.model ?? DEFAULT_MODELS.opus,
    compatShape: "openai",
  };

  return adapter.spawn(opts.passthrough ?? [], routing);
}
