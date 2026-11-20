import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
const mocks = vi.hoisted(() => ({
  updateConfig: vi.fn(),
  initialize: vi.fn(),
  wrapWithSandbox: vi.fn(),
  reset: vi.fn(),
  getSandboxViolationStore: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("@anthropic-ai/sandbox-runtime", () => ({ SandboxManager: mocks }));
vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
  execFile: vi.fn(),
}));
import { loadSrt, runSrt, shellQuote } from "../../src/sandbox/srt.js";
const nodeVersion = process.versions.node;
beforeEach(() => {
  Object.defineProperty(process.versions, "node", {
    value: "22.12.0",
    configurable: true,
  });
  vi.resetAllMocks();
  mocks.initialize.mockResolvedValue(undefined);
  mocks.wrapWithSandbox.mockResolvedValue("sandboxed command");
  mocks.reset.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process.versions, "node", {
    value: nodeVersion,
    configurable: true,
  });
});
describe("SRT library", () => {
  it("quotes shell metacharacters as literal arguments", () => {
    expect(shellQuote("a'$(touch nope)\n")).toBe("'a'\\''$(touch nope)\n'");
  });
  it.each([false, true])(
    "resets proxies on child completion or startup failure (%s)",
    async (fail) => {
      mocks.spawn.mockImplementation(() => {
        const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
        setImmediate(() =>
          fail
            ? child.emit("error", new Error("spawn failed"))
            : child.emit("close", 7),
        );
        return child;
      });
      const env = { HOME: "/temporary", PATH: "/bin" };
      const run = runSrt(
        ["/bin/echo", "a ' quote"],
        {
          network: { allowedDomains: ["api.opper.ai"], deniedDomains: [] },
          filesystem: { allowWrite: ["/project"], denyRead: [], denyWrite: [] },
        },
        env,
        "/project",
      );
      if (fail) await expect(run).rejects.toThrow("spawn failed");
      else expect(await run).toBe(7);
      expect(mocks.spawn).toHaveBeenCalledWith(
        "/bin/sh",
        ["-c", "sandboxed command"],
        { cwd: "/project", env, stdio: "inherit", detached: true },
      );
      expect(mocks.reset).toHaveBeenCalledOnce();
    },
  );
  it("cleans up partial initialization and never launches after setup fails", async () => {
    mocks.initialize.mockRejectedValue(new Error("policy failure"));
    await expect(runSrt([], {} as any, {}, "/project")).rejects.toThrow(
      "policy failure",
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.reset).toHaveBeenCalledOnce();
  });
});

it("logs unmatched network requests while keeping them denied", async () => {
  const emit = vi.fn();
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    setImmediate(() => child.emit("close", 0));
    return child;
  });
  const config = {
    network: { allowedDomains: ["api.opper.ai"], deniedDomains: [] },
    filesystem: { allowWrite: [], denyRead: [], denyWrite: [] },
  };
  await runSrt(["echo"], config, {}, "/project", emit);
  // The allowlist is decided in the callback so allowed hosts are logged too.
  const [applied, callback] = mocks.initialize.mock.calls[0]!;
  expect(applied.network.allowedDomains).toEqual([]);
  expect(await callback({ host: "unlisted.example", port: 443 })).toBe(false);
  expect(emit).toHaveBeenCalledWith("NETWORK", "unlisted.example:443 blocked");
  expect(await callback({ host: "API.opper.ai", port: 443 })).toBe(true);
  expect(emit).toHaveBeenCalledWith("NETWORK", "API.opper.ai:443 allowed");
  expect(await callback({ host: "evil-api.opper.ai.example", port: 443 })).toBe(
    false,
  );
});

it("can open the network while logging hosts and query-free URLs", async () => {
  const emit = vi.fn();
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    setImmediate(() => child.emit("close", 0));
    return child;
  });
  const config = {
    network: {
      allowedDomains: ["api.opper.ai"],
      deniedDomains: ["bad.example"],
    },
    filesystem: { allowWrite: [], denyRead: [], denyWrite: [] },
  };
  await runSrt(["echo"], config, {}, "/project", emit, undefined, {
    allowAll: true,
    urls: true,
  });
  const [applied, callback] = mocks.initialize.mock.calls[0]!;
  // An empty allowlist sends every host to the callback; denies stay.
  expect(applied.network.allowedDomains).toEqual([]);
  expect(applied.network.deniedDomains).toEqual(["bad.example"]);
  expect(applied.network.tlsTerminate).toEqual({});
  expect(await callback({ host: "anything.example", port: 443 })).toBe(true);
  expect(emit).toHaveBeenCalledWith("NETWORK", "anything.example:443 allowed");
  expect(
    await applied.network.filterRequest(
      new Request("https://anything.example/a/b?token=secret", {
        method: "POST",
      }),
      { scheme: "https" },
    ),
  ).toEqual({ action: "allow" });
  expect(emit).toHaveBeenCalledWith(
    "REQUEST",
    "POST https://anything.example/a/b",
  );
  expect(JSON.stringify(emit.mock.calls)).not.toContain("secret");
});

it("logs connections refused by a deny rule from SRT's violation reports", async () => {
  const emit = vi.fn();
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    setImmediate(() => child.emit("close", 0));
    return child;
  });
  let report!: (violations: { line: string }[]) => void;
  mocks.getSandboxViolationStore.mockReturnValue({
    subscribe: (listener: typeof report) => {
      report = listener;
      return () => {};
    },
  });
  await runSrt(
    ["echo"],
    {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { allowWrite: [], denyRead: [], denyWrite: [] },
    },
    {},
    "/project",
    emit,
  );
  const denied = {
    line: "deny network-outbound EXAMPLE.ORG.:443 (host is on the deny list)",
  };
  report([
    denied,
    { line: "deny network-outbound other.example:443 (user denied)" },
  ]);
  report([denied]);
  expect(emit.mock.calls.filter(([kind]) => kind === "NETWORK")).toEqual([
    ["NETWORK", "example.org:443 blocked"],
  ]);
});

it("signals the whole sandbox process group and reaps leftover children", async () => {
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const child = Object.assign(new EventEmitter(), {
    pid: 123456,
    kill: vi.fn(),
  });
  let spawned!: () => void;
  const started = new Promise<void>((resolve) => {
    spawned = resolve;
  });
  mocks.spawn.mockImplementation(() => {
    spawned();
    return child;
  });
  const result = runSrt(["agent"], {} as any, {}, "/project");
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
  process.emit("SIGTERM");
  expect(kill).toHaveBeenCalledWith(-123456, "SIGTERM");
  child.emit("close", null, "SIGTERM");
  expect(await result).toBe(143);
  expect(kill).toHaveBeenCalledWith(-123456, "SIGKILL");
});

it("rejects unsupported Node versions before initializing the optional runtime", async () => {
  Object.defineProperty(process.versions, "node", {
    value: "20.20.2",
    configurable: true,
  });
  await expect(loadSrt()).rejects.toMatchObject({
    code: "AGENT_NOT_FOUND",
    hint: expect.stringContaining("Node >=22.12"),
  });
  expect(mocks.initialize).not.toHaveBeenCalled();
});

it.each(["initialize", "wrapWithSandbox"] as const)(
  "does not spawn after cancellation during %s",
  async (stage) => {
    let finish!: (value?: any) => void;
    mocks[stage].mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const listeners = process.listenerCount("SIGTERM");
    const result = runSrt(["agent"], {} as any, {}, "/project");
    await vi.waitFor(() => expect(finish).toBeDefined());
    process.emit("SIGTERM");
    finish("wrapped");
    expect(await result).toBe(143);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.reset).toHaveBeenCalledOnce();
    expect(process.listenerCount("SIGTERM")).toBe(listeners);
  },
);

it("hot loads network policy without respawning and acknowledges only successful updates", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { changePolicy } =
    await import("../../scripts/sandbox-policy/policy.mjs");
  const directory = mkdtempSync(join(tmpdir(), "srt-policy-test-"));
  const child = Object.assign(new EventEmitter(), { pid: 123456789 });
  let spawned!: () => void;
  const started = new Promise<void>((resolve) => {
    spawned = resolve;
  });
  mocks.spawn.mockImplementation(() => {
    spawned();
    return child;
  });
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const activity = vi.fn();
  vi.useFakeTimers();
  try {
    const running = runSrt(
      ["agent"],
      {
        network: { allowedDomains: ["example.com"], deniedDomains: [] },
        filesystem: { allowWrite: [], denyRead: [], denyWrite: [] },
      },
      {},
      "/project",
      activity,
      directory,
    );
    await started;
    changePolicy(0, "example.com", "deny", directory);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.updateConfig.mock.calls[0]?.[0].network).toEqual({
      allowedDomains: [],
      deniedDomains: ["example.com"],
    });
    expect(activity).toHaveBeenCalledWith("POLICY", "1");
    mocks.updateConfig.mockImplementation(() => {
      throw new Error("update failed");
    });
    changePolicy(1, "example.com", "allow", directory);
    await vi.advanceTimersByTimeAsync(1000);
    expect(activity).not.toHaveBeenCalledWith("POLICY", "2");
    expect(kill).toHaveBeenCalledWith(-123456789, "SIGKILL");
    child.emit("close", 1);
    await running;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  }
});
