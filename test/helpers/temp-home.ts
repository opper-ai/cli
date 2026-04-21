import { afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates a fresh OPPER_HOME dir per test and cleans up after.
 * Returns a `get()` accessor so tests can read the current path.
 */
export function useTempOpperHome(): { get(): string } {
  let dir: string | null = null;
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.OPPER_HOME;
    dir = mkdtempSync(join(tmpdir(), "opper-test-"));
    process.env.OPPER_HOME = dir;
  });

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
    if (prev === undefined) delete process.env.OPPER_HOME;
    else process.env.OPPER_HOME = prev;
  });

  return {
    get() {
      if (!dir) throw new Error("useTempOpperHome() used outside a test");
      return dir;
    },
  };
}
