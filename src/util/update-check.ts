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
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
type Distribution = "npm" | "bundle";

interface Cache {
  checkedAt: number;
  latest: string;
}

function cachePath(distribution: Distribution): string {
  const xdg = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(xdg, "opper", distribution === "bundle" ? "update-check-bundle.json" : "update-check.json");
}

function readCache(distribution: Distribution): Cache | null {
  try {
    const raw = readFileSync(cachePath(distribution), "utf8");
    const parsed = JSON.parse(raw) as Partial<Cache>;
    if (typeof parsed.checkedAt !== "number" || typeof parsed.latest !== "string") {
      return null;
    }
    if (distribution === "bundle" && !STABLE_VERSION.test(parsed.latest)) return null;
    return parsed as Cache;
  } catch {
    return null;
  }
}

function writeCache(cache: Cache, distribution: Distribution): void {
  try {
    mkdirSync(dirname(cachePath(distribution)), { recursive: true });
    writeFileSync(cachePath(distribution), JSON.stringify(cache));
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

async function fetchLatest(name: string, distribution: Distribution): Promise<string> {
  const bundled = distribution === "bundle";
  const url = bundled
    ? "https://api.github.com/repos/opper-ai/cli/releases/latest"
    : `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      ...(bundled ? { headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" } } : {}),
    });
    if (!res.ok) throw new Error(`update source returned ${res.status}`);
    const body = (await res.json()) as { version?: unknown; tag_name?: unknown; draft?: unknown; prerelease?: unknown } | null;
    if (bundled) {
      if (body?.draft !== false || body.prerelease !== false || typeof body.tag_name !== "string" || !body.tag_name.startsWith("v") || !STABLE_VERSION.test(body.tag_name.slice(1))) {
        throw new Error("GitHub response missing a published stable release tag");
      }
      return body.tag_name.slice(1);
    }
    if (typeof body?.version !== "string") {
      throw new Error("registry response missing version");
    }
    return body.version;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bundles (OPPER_DISTRIBUTION=bundle, set by their launcher) update through
 * their installer. `npm i -g` would put a second copy beside them.
 */
export function updateInstruction(name: string, distribution = process.env.OPPER_DISTRIBUTION): string {
  if (distribution === "bundle") {
    return `Update with the tool that installed opper, such as ${brand.accent("mise up")} (or ${brand.accent("omarchy update")} on Omarchy)`;
  }
  return `Run ${brand.accent(`npm i -g ${name}`)} to update`;
}

function printNotice(name: string, current: string, latest: string, distribution: Distribution): void {
  process.stderr.write("\n");
  process.stderr.write(
    `  ${brand.bold("Update available")} ${brand.dim(current)} → ${brand.accent(latest)}\n`,
  );
  process.stderr.write(`  ${updateInstruction(name, distribution)}\n`);
  process.stderr.write("\n");
}

export async function checkForUpdate(pkg: {
  name: string;
  version: string;
}): Promise<void> {
  if (isDisabled()) return;
  if (!process.stdout.isTTY) return;

  const distribution: Distribution = process.env.OPPER_DISTRIBUTION === "bundle" ? "bundle" : "npm";
  let cache = readCache(distribution);
  const stale = !cache || Date.now() - cache.checkedAt > TTL_MS;

  if (stale) {
    try {
      const latest = await fetchLatest(pkg.name, distribution);
      cache = { checkedAt: Date.now(), latest };
      writeCache(cache, distribution);
    } catch {
      // network failure: fall through to whatever stale cache we already have
    }
  }

  if (cache && isNewer(cache.latest, pkg.version)) {
    const latest = cache.latest;
    // `once` so a hypothetical second invocation in the same process doesn't
    // stack listeners (and trip Node's MaxListenersExceededWarning at 11+).
    process.once("exit", () => {
      printNotice(pkg.name, pkg.version, latest, distribution);
    });
  }
}
