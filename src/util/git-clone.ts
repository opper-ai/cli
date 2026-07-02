import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./run.js";
import { OpperError } from "../errors.js";

/**
 * Shallow-clones a git repo (optionally a branch/tag) into a fresh temp
 * directory using the system `git`. Returns the checkout path and a
 * cleanup function.
 */
export async function cloneRepo(
  url: string,
  ref?: string,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const tmp = await mkdtemp(join(tmpdir(), "opper-clone-"));
  const args = [
    "clone",
    "--depth",
    "1",
    ...(ref ? ["--branch", ref] : []),
    url,
    tmp,
  ];
  const result = run("git", args);
  if (result.code !== 0) {
    await rm(tmp, { recursive: true, force: true });
    throw new OpperError(
      "INVALID_ARGUMENT",
      `git clone failed (exit ${result.code}): ${result.stderr.trim().split("\n").pop() ?? ""}`,
      "Check the URL (and --ref branch/tag) and that you have access to the repository.",
    );
  }
  return {
    dir: tmp,
    cleanup: () => rm(tmp, { recursive: true, force: true }),
  };
}
