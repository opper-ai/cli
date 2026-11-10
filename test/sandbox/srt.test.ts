import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  wrapWithSandbox: vi.fn(),
  reset: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("@anthropic-ai/sandbox-runtime", () => ({ SandboxManager: mocks }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
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
  expect(mocks.initialize.mock.calls[0]![0]).toBe(config);
  const callback = mocks.initialize.mock.calls[0]![1];
  expect(await callback({ host: "unlisted.example", port: 443 })).toBe(false);
  expect(emit).toHaveBeenCalledWith("NETWORK", "unlisted.example:443 blocked");
});

it("signals the whole sandbox process group and reaps leftover children", async () => {
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const child = Object.assign(new EventEmitter(), {
    pid: 123456,
    kill: vi.fn(),
  });
  mocks.spawn.mockReturnValue(child);
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
