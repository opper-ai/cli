import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Resolves a path inside the bundled `data/` directory.
 *
 * Layout at runtime: `dist/util/assets.js` has `../../data/` next to it.
 * Same relative math works from `src/util/assets.ts` during tests since
 * `<repo>/data/` is also two levels up.
 */
export function assetPath(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "data", name);
}
