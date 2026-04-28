import { configureOpenCode } from "../setup/opencode.js";
import { listAdapters } from "../agents/registry.js";
import { isLaunchable } from "../agents/types.js";
import { brand } from "../ui/colors.js";
import type { Location } from "../util/editor-paths.js";

export interface EditorsOpenCodeOptions {
  location: Location;
  overwrite: boolean;
}

/**
 * Lists configure-only integrations from the agents registry. Anything in
 * the registry without a `spawn` method is "an editor" for this command's
 * purposes; launchable agents show up via `opper agents list`.
 */
export async function editorsListCommand(): Promise<void> {
  const editors = listAdapters().filter((a) => !isLaunchable(a));
  if (editors.length === 0) {
    console.log("(no editor integrations registered)");
    return;
  }
  for (const adapter of editors) {
    const configured = await adapter.isConfigured();
    const status = configured
      ? brand.accent("configured")
      : brand.dim("not configured");
    console.log(
      `${adapter.displayName.padEnd(14)} ${status}  ${brand.dim(adapter.docsUrl)}`,
    );
  }
}

export async function editorsOpenCodeCommand(
  opts: EditorsOpenCodeOptions,
): Promise<void> {
  const result = await configureOpenCode({
    location: opts.location,
    ...(opts.overwrite ? { overwrite: true } : {}),
  });
  if (!result.wrote && result.reason === "exists") {
    console.log(
      `OpenCode config at ${result.path} already has an Opper provider. Pass --overwrite to replace it.`,
    );
    return;
  }
  console.log(brand.accent(`✓ Wrote OpenCode config to ${result.path}.`));
}
