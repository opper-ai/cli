import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { run } from "./run.js";
import { OpperError } from "../errors.js";

// Directories that never belong in an app source upload. Mirrors the Go
// deploy CLI's exclusions (plus .venv variants pip/uv create).
const EXCLUDES = [".git", "node_modules", "__pycache__", ".venv", "venv"];

/**
 * Packs `dir` into a gzipped tarball in a fresh temp directory using the
 * system `tar` (BSD and GNU both accept this flag shape). Returns the
 * tarball path and a cleanup function that removes the temp dir.
 */
export async function makeTarball(
  dir: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  if (!existsSync(dir)) {
    throw new OpperError(
      "INVALID_ARGUMENT",
      `Source directory not found: ${dir}`,
      "Pass the directory containing your agent source via --dir.",
    );
  }
  const tmp = await mkdtemp(join(tmpdir(), "opper-app-"));
  const out = join(tmp, "src.tar.gz");
  const args = [
    "-czf",
    out,
    ...EXCLUDES.flatMap((e) => ["--exclude", e]),
    "-C",
    dir,
    ".",
  ];
  const result = run("tar", args);
  if (result.code !== 0) {
    await rm(tmp, { recursive: true, force: true });
    throw new OpperError(
      "INVALID_ARGUMENT",
      `tar failed (exit ${result.code}): ${result.stderr.trim()}`,
      "Check the directory is readable and `tar` is on PATH.",
    );
  }
  return {
    path: out,
    cleanup: () => rm(tmp, { recursive: true, force: true }),
  };
}
