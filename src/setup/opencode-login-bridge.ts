import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assetPath } from "../util/assets.js";
import { opencodeConfigPath } from "../util/editor-paths.js";
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

export async function installOpenCodeLoginBridge(): Promise<{ path: string }> {
  const path = openCodeLoginBridgePath();
  const managed = await existingManaged(path);
  if (managed === false) {
    throw new OpperError(
      "AGENT_CONFIG_CONFLICT",
      `OpenCode plugin at ${path} is not managed by Opper; it was preserved.`,
    );
  }
  const source = await readFile(assetPath("opencode-login-plugin.js"), "utf8");
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
