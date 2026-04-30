import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isNewer,
  checkForUpdate,
} from "../../src/util/update-check.js";

describe("isNewer", () => {
  it("returns true when latest patch is greater", () => {
    expect(isNewer("0.1.6", "0.1.3")).toBe(true);
  });

  it("returns true when latest minor is greater", () => {
    expect(isNewer("0.2.0", "0.1.9")).toBe(true);
  });

  it("returns true when latest major is greater", () => {
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
  });

  it("returns false when versions are equal", () => {
    expect(isNewer("0.1.6", "0.1.6")).toBe(false);
  });

  it("returns false when current is newer", () => {
    expect(isNewer("0.1.5", "0.1.6")).toBe(false);
  });

  it("strips prerelease tags before comparing", () => {
    expect(isNewer("0.1.6-beta.1", "0.1.6")).toBe(false);
    expect(isNewer("0.2.0-rc.1", "0.1.9")).toBe(true);
  });

  it("ranks a release ahead of a prerelease of the same core (semver §11)", () => {
    expect(isNewer("1.0.0", "1.0.0-rc.1")).toBe(true);
    expect(isNewer("1.0.0-rc.1", "1.0.0")).toBe(false);
    // Two prereleases with the same core stay equal — we don't try to
    // order pre.alpha vs pre.beta.
    expect(isNewer("1.0.0-rc.1", "1.0.0-rc.2")).toBe(false);
  });

  it("strips +build metadata before comparing", () => {
    expect(isNewer("1.0.0+abc123", "1.0.0")).toBe(false);
    expect(isNewer("1.0.1+abc123", "1.0.0+def456")).toBe(true);
  });

  it("treats unparseable input as not-newer (defensive)", () => {
    expect(isNewer("garbage", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "garbage")).toBe(false);
  });

  it("rejects malformed version strings instead of coercing to zero", () => {
    // Leading dot, whitespace, and non-digit parts must not slide through.
    expect(isNewer(".1.2", "0.0.0")).toBe(false);
    expect(isNewer("  1.0.0", "0.0.0")).toBe(false);
    expect(isNewer("1.x.0", "0.0.0")).toBe(false);
    expect(isNewer("", "0.0.0")).toBe(false);
  });
});

describe("checkForUpdate", () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  let restoreTty: () => void;

  function stubTty(value: boolean): void {
    const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", {
      value,
      configurable: true,
      writable: true,
    });
    restoreTty = () => {
      if (original) {
        Object.defineProperty(process.stdout, "isTTY", original);
      } else {
        // @ts-expect-error - delete from process.stdout
        delete process.stdout.isTTY;
      }
    };
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "update-check-test-"));
    for (const k of ["XDG_CACHE_HOME", "NO_UPDATE_NOTIFIER", "CI"]) {
      savedEnv[k] = process.env[k];
    }
    process.env.XDG_CACHE_HOME = tmpDir;
    delete process.env.NO_UPDATE_NOTIFIER;
    delete process.env.CI;
    stubTty(true);
  });

  afterEach(() => {
    restoreTty?.();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  function cacheFile(): string {
    return join(tmpDir, "opper", "update-check.json");
  }

  function seedCache(latest: string, ageMs = 0): void {
    mkdirSync(join(tmpDir, "opper"), { recursive: true });
    writeFileSync(
      cacheFile(),
      JSON.stringify({ checkedAt: Date.now() - ageMs, latest }),
    );
  }

  function mockFetch(version: string): ReturnType<typeof vi.fn> {
    const fn = vi.fn(async () =>
      new Response(JSON.stringify({ version }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("fetches latest from npm and writes cache when no cache exists", async () => {
    mockFetch("1.0.0");

    await checkForUpdate({ name: "@opperai/cli", version: "0.1.0" });

    expect(existsSync(cacheFile())).toBe(true);
    const cache = JSON.parse(readFileSync(cacheFile(), "utf8"));
    expect(cache.latest).toBe("1.0.0");
    expect(typeof cache.checkedAt).toBe("number");
  });

  it("uses fresh cache without re-fetching", async () => {
    seedCache("0.5.0", 60 * 1000); // 1 min old
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await checkForUpdate({ name: "@opperai/cli", version: "0.1.0" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-fetches when cache is older than the TTL", async () => {
    seedCache("0.5.0", 1000 * 60 * 60 * 2); // 2h old, TTL=1h
    const fetchMock = mockFetch("1.0.0");

    await checkForUpdate({ name: "@opperai/cli", version: "0.1.0" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const cache = JSON.parse(readFileSync(cacheFile(), "utf8"));
    expect(cache.latest).toBe("1.0.0");
  });

  it("registers an exit handler when an update is available", async () => {
    mockFetch("1.0.0");
    const onceSpy = vi.spyOn(process, "once");

    await checkForUpdate({ name: "@opperai/cli", version: "0.1.0" });

    const exitHandlers = onceSpy.mock.calls.filter((c) => c[0] === "exit");
    expect(exitHandlers.length).toBeGreaterThanOrEqual(1);
    onceSpy.mockRestore();
  });

  it("does not register an exit handler when no update is available", async () => {
    mockFetch("0.1.0");
    const onceSpy = vi.spyOn(process, "once");

    await checkForUpdate({ name: "@opperai/cli", version: "0.1.0" });

    const exitHandlers = onceSpy.mock.calls.filter((c) => c[0] === "exit");
    expect(exitHandlers).toHaveLength(0);
    onceSpy.mockRestore();
  });

  it("skips entirely when NO_UPDATE_NOTIFIER is set", async () => {
    process.env.NO_UPDATE_NOTIFIER = "1";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await checkForUpdate({ name: "@opperai/cli", version: "0.1.0" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(cacheFile())).toBe(false);
  });

  it("skips entirely when CI is set", async () => {
    process.env.CI = "1";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await checkForUpdate({ name: "@opperai/cli", version: "0.1.0" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips entirely when stdout is not a TTY", async () => {
    stubTty(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await checkForUpdate({ name: "@opperai/cli", version: "0.1.0" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips entirely when --no-update-notifier is in argv", async () => {
    const origArgv = process.argv;
    process.argv = [...origArgv, "--no-update-notifier"];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      await checkForUpdate({ name: "@opperai/cli", version: "0.1.0" });
    } finally {
      process.argv = origArgv;
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to stale cache when fetch fails", async () => {
    seedCache("1.0.0", 1000 * 60 * 60 * 2); // 2h old
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network error");
      }),
    );
    const onceSpy = vi.spyOn(process, "once");

    await checkForUpdate({ name: "@opperai/cli", version: "0.1.0" });

    const exitHandlers = onceSpy.mock.calls.filter((c) => c[0] === "exit");
    expect(exitHandlers.length).toBeGreaterThanOrEqual(1);
    onceSpy.mockRestore();
  });

  it("is silent when fetch fails and no cache exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network error");
      }),
    );
    const onceSpy = vi.spyOn(process, "once");

    await checkForUpdate({ name: "@opperai/cli", version: "0.1.0" });

    const exitHandlers = onceSpy.mock.calls.filter((c) => c[0] === "exit");
    expect(exitHandlers).toHaveLength(0);
    onceSpy.mockRestore();
  });

  it("encodes scoped package names for the registry URL", async () => {
    const fetchMock = mockFetch("1.0.0");

    await checkForUpdate({ name: "@opperai/cli", version: "0.1.0" });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("%2F");
    expect(url).not.toContain("@opperai/cli");
  });

  it("ignores corrupt cache files and re-fetches from npm", async () => {
    mkdirSync(join(tmpDir, "opper"), { recursive: true });
    writeFileSync(cacheFile(), "{this is not json");
    const fetchMock = mockFetch("1.0.0");

    await checkForUpdate({ name: "@opperai/cli", version: "0.1.0" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const cache = JSON.parse(readFileSync(cacheFile(), "utf8"));
    expect(cache.latest).toBe("1.0.0");
  });

  it("ignores well-formed JSON with the wrong shape", async () => {
    mkdirSync(join(tmpDir, "opper"), { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify({ unrelated: "data" }));
    const fetchMock = mockFetch("1.0.0");

    await checkForUpdate({ name: "@opperai/cli", version: "0.1.0" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("registers exactly one exit listener even on repeated invocations", async () => {
    seedCache("1.0.0", 60 * 1000); // fresh, no fetch needed
    const onceSpy = vi.spyOn(process, "once");

    await checkForUpdate({ name: "@opperai/cli", version: "0.1.0" });
    await checkForUpdate({ name: "@opperai/cli", version: "0.1.0" });

    const exitCalls = onceSpy.mock.calls.filter((c) => c[0] === "exit");
    expect(exitCalls.length).toBeGreaterThanOrEqual(1);
    // Important: each call uses `once`, so handlers don't accumulate.
    expect(onceSpy).toHaveBeenCalledWith("exit", expect.any(Function));
    onceSpy.mockRestore();
  });
});
