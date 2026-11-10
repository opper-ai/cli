import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const { runSrt, loadSrt } = vi.hoisted(() => ({
  runSrt: vi.fn(),
  loadSrt: vi.fn(),
}));
vi.mock("../../src/sandbox/srt.js", () => ({ runSrt, loadSrt }));
import {
  checkSandbox,
  launchSandbox,
  sandboxEnvironment,
} from "../../src/sandbox/launch.js";

const request = {
  agent: "claude",
  args: ["-p", "literal ' $(touch /tmp/nope)"],
  routing: {
    apiBaseUrl: "https://api.opper.ai",
    baseUrl: "https://api.opper.ai/v3/session/test",
    apiKey: "test-only-secret",
    model: "test-model",
    compatShape: "openai" as const,
  },
  spawnOptions: {},
};

beforeEach(() => {
  vi.resetAllMocks();
  runSrt.mockResolvedValue(0);
  loadSrt.mockResolvedValue({});
});

describe("sandbox validation", () => {
  it("rejects unknown backends, incompatible platforms, and background agents", async () => {
    await expect(checkSandbox("toString", "claude", "darwin")).rejects.toThrow(
      /Unknown sandbox/,
    );
    await expect(checkSandbox("srt", "claude", "win32")).rejects.toThrow(
      /not supported/,
    );
    await expect(checkSandbox("srt", "openclaw", "darwin")).rejects.toThrow(
      /does not support/,
    );
    expect(loadSrt).not.toHaveBeenCalled();
  });
  it("fails when a runtime is missing instead of launching without isolation", async () => {
    loadSrt.mockRejectedValue(new Error("Library unavailable"));
    await expect(checkSandbox("srt", "claude", "linux")).rejects.toThrow(
      "Library unavailable",
    );
    expect(runSrt).not.toHaveBeenCalled();
  });
});

describe("sandbox launch", () => {
  it("does not inherit credentials, config overrides, sockets or Node startup hooks", () => {
    const env = sandboxEnvironment("/new/home", "/new/tmp", {
      PATH: "/bin",
      TERM: "xterm",
      AWS_SECRET_ACCESS_KEY: "secret",
      NODE_OPTIONS: "--require evil",
      SSH_AUTH_SOCK: "/socket",
      OPPER_HOME: "/original",
      CODEX_HOME: "/original",
      HOME: "/original",
      CLAUDE_CODE_TMPDIR: "/outside",
    });
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/new/home");
    expect(env.CLAUDE_CODE_TMPDIR).toBe("/new/tmp");
    for (const name of [
      "AWS_SECRET_ACCESS_KEY",
      "NODE_OPTIONS",
      "SSH_AUTH_SOCK",
      "OPPER_HOME",
      "CODEX_HOME",
    ])
      expect(env).not.toHaveProperty(name);
  });
  it("keeps credentials out of argv and cleans up even when the runtime fails", async () => {
    let session = "";
    runSrt.mockImplementation(async (args, _settings, env) => {
      const requestPath = args.at(-1);
      session = dirname(requestPath);
      expect(JSON.parse(readFileSync(requestPath, "utf8"))).toEqual({
        ...request,
        activityDirectory: join(session, "events"),
      });
      if (process.platform !== "win32")
        expect(statSync(requestPath).mode & 0o777).toBe(0o600);
      expect(args.join(" ")).not.toContain("test-only-secret");
      expect(env.HOME).toBe(join(session, "home"));
      return 71;
    });
    expect(await launchSandbox("srt", request)).toBe(71);
    expect(existsSync(session)).toBe(false);
    expect(runSrt).toHaveBeenCalledTimes(1);
  });
  it("cleans up on spawn errors", async () => {
    let home = "";
    runSrt.mockImplementation(async (_args, _settings, env) => {
      home = env.HOME;
      throw new Error("ENOENT");
    });
    await expect(launchSandbox("srt", request)).rejects.toThrow(/ENOENT/);
    expect(existsSync(home)).toBe(false);
  });
  it("restricts SRT network to the routing host and explicit extra hosts", async () => {
    runSrt.mockImplementation(async (command, settings) => {
      expect(settings.network.allowedDomains).toEqual([
        "api.opper.ai",
        "registry.npmjs.org",
      ]);
      expect(
        settings.filesystem.denyRead.some(
          (entry: { path: string; literal: boolean }) =>
            basename(entry.path) === ".ssh" && entry.literal,
        ),
      ).toBe(true);
      expect(command.join(" ")).not.toContain(request.routing.apiKey);
      return 7;
    });
    expect(await launchSandbox("srt", request, ["registry.npmjs.org"])).toBe(7);
  });
});
