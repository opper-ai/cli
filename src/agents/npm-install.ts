import { run } from "../util/run.js";
import { which } from "../util/which.js";
import { OpperError } from "../errors.js";

// On Windows, npm ships as a `.cmd` shim. Node refuses to execute .cmd
// files via spawnSync without a shell — even when given the explicit
// extension — so we have to route through cmd.exe (shell: true) on
// Windows. POSIX still runs npm directly, no shell.
const USE_SHELL = process.platform === "win32";

/**
 * Run `npm install -g <pkg>` and surface a useful error if it fails.
 * Used by every adapter whose upstream agent ships as a global npm package.
 */
export async function npmInstallGlobal(
  packageName: string,
  docsUrl: string,
): Promise<void> {
  if (!(await which("npm"))) {
    throw new OpperError(
      "AGENT_NOT_FOUND",
      "npm is required to install this agent but was not found on PATH.",
      `Install Node.js (which ships npm) from https://nodejs.org, or install ${packageName} manually from ${docsUrl}.`,
    );
  }

  const result = run("npm", ["install", "-g", packageName], {
    inherit: true,
    shell: USE_SHELL,
  });
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
