import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
const mocks = vi.hoisted(() => ({
  home: "",
  runSrt: vi.fn(),
  which: vi.fn(),
  checkSandbox: vi.fn(),
}));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => mocks.home,
}));
vi.mock("../../src/sandbox/srt.js", async (original) => ({
  ...(await original<typeof import("../../src/sandbox/srt.js")>()),
  runSrt: mocks.runSrt,
}));
vi.mock("../../src/sandbox/launch.js", async (original) => ({
  ...(await original<typeof import("../../src/sandbox/launch.js")>()),
  checkSandbox: mocks.checkSandbox,
}));
vi.mock("../../src/util/which.js", () => ({ which: mocks.which }));
import { launchDune, claudeDomains } from "../../src/sandbox/dune.js";
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.home = await realpath(await mkdtemp(join(tmpdir(), "dune-test-")));
  mocks.which.mockResolvedValue("/installed/claude");
  mocks.checkSandbox.mockResolvedValue("srt");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(mocks.home, { recursive: true, force: true });
});
it("runs native Claude without Opper routing and preserves only its dedicated profile", async () => {
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "unrelated-secret");
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://gateway.example");
  vi.stubEnv("ANTHROPIC_API_KEY", "api-secret");
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "subscription-token");
  let sessionHome = "",
    log = "";
  mocks.runSrt.mockImplementation(async (command, config, env, _cwd, emit) => {
    sessionHome = env.HOME;
    expect(command[0]).toBe("/installed/claude");
    expect(command.slice(-2)).toEqual(["-p", "hello"]);
    expect(command.join(" ")).not.toContain("subscription-token");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("subscription-token");
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(mocks.home, ".dune", "claude"));
    for (const key of [
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "OPPER_API_KEY",
    ])
      expect(env[key]).toBeUndefined();
    expect(config.network.allowedDomains).toEqual([
      ...claudeDomains,
      "github.com",
    ]);
    expect(JSON.parse(readFileSync(command[2], "utf8")).sandbox.enabled).toBe(
      false,
    );
    log = join(config.filesystem.denyWrite[0].path, "activity.log");
    emit("NETWORK", "subscription-token blocked");
    return 7;
  });
  expect(await launchDune(["-p", "hello"], ["github.com"])).toBe(7);
  expect(existsSync(sessionHome)).toBe(false);
  expect(existsSync(join(mocks.home, ".dune", "claude"))).toBe(true);
  expect(readFileSync(log, "utf8")).not.toContain("subscription-token");
  await rm(dirname(log), { recursive: true, force: true });
});
it("does not launch when SRT validation fails", async () => {
  mocks.checkSandbox.mockRejectedValue(new Error("unavailable"));
  await expect(launchDune([])).rejects.toThrow("unavailable");
  expect(mocks.runSrt).not.toHaveBeenCalled();
});
