import {
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { brand } from "../ui/colors.js";

const TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1000;

interface Cache {
  checkedAt: number;
  latest: string;
}

function cachePath(): string {
  const xdg = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(xdg, "opper", "update-check.json");
}

function readCache(): Cache | null {
  try {
    const raw = readFileSync(cachePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<Cache>;
    if (typeof parsed.checkedAt !== "number" || typeof parsed.latest !== "string") {
      return null;
    }
    return parsed as Cache;
  } catch {
    return null;
  }
}

function writeCache(cache: Cache): void {
  try {
    mkdirSync(dirname(cachePath()), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(cache));
  } catch {
    // best-effort; a read-only home shouldn't break the CLI
  }
}

function isDisabled(): boolean {
  return (
    process.env.NO_UPDATE_NOTIFIER !== undefined ||
    process.env.CI !== undefined ||
    process.argv.includes("--no-update-notifier")
  );
}

export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string): { parts: number[]; pre: boolean } | null => {
    const noBuild = v.split("+")[0] ?? "";
    const dash = noBuild.indexOf("-");
    const core = dash < 0 ? noBuild : noBuild.slice(0, dash);
    const pre = dash >= 0;
    const segments = core.split(".");
    if (segments.length === 0) return null;
    const parts = segments.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
    if (parts.some((n) => !Number.isFinite(n))) return null;
    return { parts, pre };
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const x = a.parts[i] ?? 0;
    const y = b.parts[i] ?? 0;
    if (x !== y) return x > y;
  }
  // Same core: a release outranks a prerelease (semver §11).
  return !a.pre && b.pre;
}

async function fetchLatest(name: string): Promise<string> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`registry returned ${res.status}`);
    const body = (await res.json()) as { version?: unknown };
    if (typeof body.version !== "string") {
      throw new Error("registry response missing version");
    }
    return body.version;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How to get the newer version. The npm package and the GitHub release
 * bundles ship from the same tag, so the version check stays on the npm
 * registry, but a bundle (OPPER_DISTRIBUTION=bundle, set by its launcher) was
 * installed by something else, typically mise, and `npm i -g` would put a
 * second copy beside it.
 */
export function updateInstruction(name: string, distribution = process.env.OPPER_DISTRIBUTION): string {
  if (distribution === "bundle") {
    return `Update with the tool that installed opper, such as ${brand.accent("mise up")} (or ${brand.accent("omarchy update")} on Omarchy)`;
  }
  return `Run ${brand.accent(`npm i -g ${name}`)} to update`;
}

function printNotice(name: string, current: string, latest: string): void {
  process.stderr.write("\n");
  process.stderr.write(
    `  ${brand.bold("Update available")} ${brand.dim(current)} → ${brand.accent(latest)}\n`,
  );
  process.stderr.write(`  ${updateInstruction(name)}\n`);
  process.stderr.write("\n");
}

export async function checkForUpdate(pkg: {
  name: string;
  version: string;
}): Promise<void> {
  if (isDisabled()) return;
  if (!process.stdout.isTTY) return;

  let cache = readCache();
  const stale = !cache || Date.now() - cache.checkedAt > TTL_MS;

  if (stale) {
    try {
      const latest = await fetchLatest(pkg.name);
      cache = { checkedAt: Date.now(), latest };
      writeCache(cache);
    } catch {
      // network failure: fall through to whatever stale cache we already have
    }
  }

  if (cache && isNewer(cache.latest, pkg.version)) {
    const latest = cache.latest;
    // `once` so a hypothetical second invocation in the same process doesn't
    // stack listeners (and trip Node's MaxListenersExceededWarning at 11+).
    process.once("exit", () => {
      printNotice(pkg.name, pkg.version, latest);
    });
  }
}
