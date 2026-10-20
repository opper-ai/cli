import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assetPath } from "../util/assets.js";
import { opencodeConfigPath } from "../util/editor-paths.js";
import { validateModelKinds, type ModelKinds } from "./model-catalog.js";
import { OpperError } from "../errors.js";

const FILE = "opper-login.js";
const MARKER = "// Managed by @opperai/cli.";

export function openCodeLoginBridgePath(): string {
  return join(dirname(opencodeConfigPath("global")), "plugins", FILE);
}

async function existingManaged(path: string): Promise<boolean | null> {
  try {
    return (await readFile(path, "utf8")).startsWith(MARKER);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function installOpenCodeLoginBridge(slot = "default", projectUuid?: string, modelKinds?: ModelKinds): Promise<{ path: string }> {
  if (modelKinds !== undefined) validateModelKinds(modelKinds);
  const path = openCodeLoginBridgePath();
  const managed = await existingManaged(path);
  if (managed === false) {
    throw new OpperError(
      "AGENT_CONFIG_CONFLICT",
      `OpenCode plugin at ${path} is not managed by Opper; it was preserved.`,
    );
  }
  const template = await readFile(assetPath("opencode-login-plugin.js"), "utf8");
  const marker = 'const DEFAULT_SLOT = "default";';
  if (!template.includes(marker)) {
    throw new OpperError("API_ERROR", "OpenCode login bridge template is missing its slot marker.");
  }
  const previous = managed ? await readFile(path, "utf8") : "";
  // A legacy plugin may back saved sessions without a persistent provider map.
  const priorKinds = /const DEFAULT_MODEL_KINDS = "(all|pools,routes)";/.exec(previous)?.[1];
  const kinds = modelKinds ?? (managed ? priorKinds ?? "all" : "pools,routes");
  const source = template.replace('const DEFAULT_MODEL_KINDS = "all";', `const DEFAULT_MODEL_KINDS = ${JSON.stringify(kinds)};`).replace(marker, `const DEFAULT_SLOT = ${JSON.stringify(slot)};`)
    .replace("const DEFAULT_PROJECT_UUID = undefined;", `const DEFAULT_PROJECT_UUID = ${projectUuid ? JSON.stringify(projectUuid) : "undefined"};`);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp.${process.pid}`;
  try {
    await writeFile(temp, source, { mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
  return { path };
}

export async function removeOpenCodeLoginBridge(): Promise<boolean> {
  const path = openCodeLoginBridgePath();
  const managed = await existingManaged(path);
  if (managed === null) return false;
  if (!managed) {
    throw new OpperError(
      "AGENT_CONFIG_CONFLICT",
      `OpenCode plugin at ${path} is not managed by Opper; it was preserved.`,
    );
  }
  await rm(path);
  return true;
}
