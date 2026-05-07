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

  // run() collapses both signal-killed children and spawn-time errors
  // (EACCES on the npm binary, transient ENOENT, etc.) to code: -1.
  // We tell them apart by stderr: with `inherit: true` run() only
  // populates stderr when it has captured an Error.message from the
  // spawn-failure path. Empty stderr ⇒ the child started and was killed
  // by a signal (almost always Ctrl-C).
  if (result.code === -1) {
    if (result.stderr.trim().length > 0) {
      throw new OpperError(
        "AGENT_NOT_FOUND",
        `npm install -g ${packageName} failed to start: ${result.stderr.trim()}`,
        `Resolve the underlying error, or install ${packageName} manually from ${docsUrl}.`,
      );
    }
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
