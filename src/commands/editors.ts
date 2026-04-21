import { configureOpenCode } from "../setup/opencode.js";
import { configureContinue } from "../setup/continue.js";
import { listEditors } from "../setup/editors.js";
import { getSlot } from "../auth/config.js";
import { OpperError } from "../errors.js";
import { brand } from "../ui/colors.js";
import type { Location } from "../util/editor-paths.js";

export interface EditorsOpenCodeOptions {
  location: Location;
  overwrite: boolean;
}

export interface EditorsContinueOptions {
  location: Location;
  overwrite: boolean;
  key: string;
}

export async function editorsListCommand(): Promise<void> {
  for (const e of listEditors()) {
    const status = e.configure ? brand.purple("auto") : brand.dim("docs-only");
    console.log(`${e.displayName.padEnd(14)} ${status}  ${brand.dim(e.docsUrl)}`);
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
  console.log(brand.purple(`✓ Wrote OpenCode config to ${result.path}.`));
}

export async function editorsContinueCommand(
  opts: EditorsContinueOptions,
): Promise<void> {
  const slot = await getSlot(opts.key);
  if (!slot) {
    throw new OpperError(
      "AUTH_REQUIRED",
      `No API key stored for slot "${opts.key}"`,
      "Run `opper login` first so Continue.dev can be configured with a key.",
    );
  }
  const result = await configureContinue({
    location: opts.location,
    apiKey: slot.apiKey,
    ...(opts.overwrite ? { overwrite: true } : {}),
  });
  if (!result.wrote && result.reason === "exists") {
    console.log(
      `Continue.dev config at ${result.path} already has Opper models. Pass --overwrite to replace them.`,
    );
    return;
  }
  console.log(brand.purple(`✓ Wrote Continue.dev config to ${result.path}.`));
}
