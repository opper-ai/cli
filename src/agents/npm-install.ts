import { run } from "../util/run.js";
import { which } from "../util/which.js";
import { OpperError } from "../errors.js";

// On Windows, npm ships as `npm.cmd`. spawnSync without `shell: true` won't
// resolve .cmd shims, so we have to invoke the right binary explicitly.
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

/**
 * Run `npm install -g <pkg>` and surface a useful error if it fails.
 * Used by every adapter whose upstream agent ships as a global npm package.
 */
export async function npmInstallGlobal(
  packageName: string,
  docsUrl: string,
): Promise<void> {
  if (!(await which(NPM))) {
    throw new OpperError(
      "AGENT_NOT_FOUND",
      "npm is required to install this agent but was not found on PATH.",
      `Install Node.js (which ships npm) from https://nodejs.org, or install ${packageName} manually from ${docsUrl}.`,
    );
  }

  const result = run(NPM, ["install", "-g", packageName], { inherit: true });
  if (result.code === 0) return;

  // run() collapses spawn errors and signal-killed children to code: -1.
  // The most common -1 here is the user hitting Ctrl-C mid-install — they
  // already know they cancelled, so don't surface a scary "exited with -1".
  if (result.code === -1) {
    throw new OpperError(
      "AGENT_NOT_FOUND",
      `npm install -g ${packageName} was interrupted before completion.`,
      `Re-run to retry, or install manually from ${docsUrl}.`,
    );
  }

  throw new OpperError(
    "AGENT_NOT_FOUND",
    `npm install -g ${packageName} exited with code ${result.code}`,
    `Check your network connection and npm permissions, or install manually from ${docsUrl}.`,
  );
}
