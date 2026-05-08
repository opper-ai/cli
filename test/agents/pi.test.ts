import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const whichMock = vi.fn();
const runMock = vi.fn();
vi.mock("../../src/util/which.js", () => ({ which: whichMock }));
vi.mock("../../src/util/run.js", () => ({ run: runMock }));

const spawnSyncMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return { ...actual, spawnSync: spawnSyncMock };
});

const { pi } = await import("../../src/agents/pi.js");

const SESSION_URL =
  "https://api.opper.ai/v3/session/sess_aa11bb22-cccc-4ddd-8eee-ffff00001111/customer:acme";

const ROUTING = {
  baseUrl: SESSION_URL,
  apiKey: "op_live_run",
  model: "claude-opus-4-7",
  compatShape: "openai" as const,
};

function readModels(sandbox: string): {
  providers?: Record<string, { baseUrl?: string; apiKey?: string }>;
} {
  const cfgPath = join(sandbox, ".pi", "agent", "models.json");
  return JSON.parse(readFileSync(cfgPath, "utf8"));
}

describe("pi adapter", () => {
  let sandbox: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    whichMock.mockReset();
    runMock.mockReset();
    spawnSyncMock.mockReset();
    sandbox = mkdtempSync(join(tmpdir(), "opper-pi-"));
    prevHome = process.env.HOME;
    process.env.HOME = sandbox;
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });

  it("metadata is correct", () => {
    expect(pi.name).toBe("pi");
    expect(pi.displayName).toBe("Pi");
    expect(typeof pi.spawn).toBe("function");
    expect(typeof pi.install).toBe("function");
  });

  it("configure (no apiKey) throws AUTH_REQUIRED", async () => {
    await expect(pi.configure({})).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });

  it("configure with apiKey writes the default compat URL into models.json", async () => {
    await pi.configure({ apiKey: "op_live_test" });
    const models = readModels(sandbox);
    expect(models.providers?.opper?.baseUrl).toBe(
      "https://api.opper.ai/v3/compat",
    );
    expect(models.providers?.opper?.apiKey).toBe("op_live_test");
  });

  it("spawn writes routing.baseUrl (the session URL) into models.json mid-launch", async () => {
    // Mid-spawn the session URL is the active baseUrl — that's how Pi
    // picks it up. We capture inside the spawn callback because we
    // restore the file on exit.
    const cfgPath = join(sandbox, ".pi", "agent", "models.json");
    let midRun: ReturnType<typeof readModels> | undefined;
    spawnSyncMock.mockImplementation(() => {
      midRun = JSON.parse(readFileSync(cfgPath, "utf8"));
      return { status: 0 };
    });

    const code = await pi.spawn!(["chat"], ROUTING);
    expect(code).toBe(0);

    expect(midRun?.providers?.opper?.baseUrl).toBe(SESSION_URL);
    expect(midRun?.providers?.opper?.apiKey).toBe("op_live_run");
  });

  it("spawn restores the pre-launch config so direct `pi` runs don't inherit the session URL", async () => {
    // User has run `opper agents add pi` previously — config has the
    // default compat URL baked in. After `opper launch pi` exits, that
    // file must be back to what the user had.
    await pi.configure({ apiKey: "op_user_key" });
    const cfgPath = join(sandbox, ".pi", "agent", "models.json");
    const before = readFileSync(cfgPath, "utf8");

    spawnSyncMock.mockReturnValue({ status: 0 });
    await pi.spawn!([], ROUTING);

    expect(readFileSync(cfgPath, "utf8")).toBe(before);
  });

  it("spawn deletes the config it created when none existed before", async () => {
    const cfgPath = join(sandbox, ".pi", "agent", "models.json");
    expect(existsSync(cfgPath)).toBe(false);

    spawnSyncMock.mockReturnValue({ status: 0 });
    await pi.spawn!([], ROUTING);

    expect(existsSync(cfgPath)).toBe(false);
  });

  it("spawn restores the pre-launch config even on non-zero exit", async () => {
    await pi.configure({ apiKey: "op_user_key" });
    const cfgPath = join(sandbox, ".pi", "agent", "models.json");
    const before = readFileSync(cfgPath, "utf8");

    spawnSyncMock.mockReturnValue({ status: 17 });
    const code = await pi.spawn!([], ROUTING);
    expect(code).toBe(17);
    expect(readFileSync(cfgPath, "utf8")).toBe(before);
  });

  it("spawn places the launch model at models[0] even when it isn't opus", async () => {
    // Read mid-spawn — snapshot/restore wipes the config on exit when
    // there was no pre-launch config.
    let midRun: ReturnType<typeof readModels> | undefined;
    spawnSyncMock.mockImplementation(() => {
      midRun = readModels(sandbox);
      return { status: 0 };
    });
    await pi.spawn!([], { ...ROUTING, model: "claude-haiku-4-5" });

    const list = (midRun as {
      providers?: { opper?: { models?: Array<{ id: string; _launch?: boolean }> } };
    } | undefined)?.providers?.opper?.models ?? [];
    expect(list[0]?.id).toBe("claude-haiku-4-5");
    expect(list[0]?._launch).toBe(true);
    // Other curated models still present after the launch entry.
    expect(list.length).toBeGreaterThan(1);
    expect(list.some((m) => m.id === "claude-opus-4-7")).toBe(true);
  });

  it("spawn prepends a non-curated --model id so it still appears in the picker", async () => {
    let midRun: ReturnType<typeof readModels> | undefined;
    spawnSyncMock.mockImplementation(() => {
      midRun = readModels(sandbox);
      return { status: 0 };
    });
    await pi.spawn!([], { ...ROUTING, model: "deepinfra/some-future-model" });

    const list = (midRun as {
      providers?: { opper?: { models?: Array<{ id: string; _launch?: boolean }> } };
    } | undefined)?.providers?.opper?.models ?? [];
    expect(list[0]?.id).toBe("deepinfra/some-future-model");
    expect(list[0]?._launch).toBe(true);
  });

  it("spawn auto-injects --provider opper and --model when user doesn't pass --model", async () => {
    spawnSyncMock.mockReturnValue({ status: 0 });
    await pi.spawn!([], ROUTING);
    const call = spawnSyncMock.mock.calls[0]!;
    expect(call[0]).toBe("pi");
    expect(call[1]).toEqual([
      "--provider",
      "opper",
      "--model",
      "claude-opus-4-7",
    ]);
  });

  it("spawn does not auto-inject --model when user already passes one", async () => {
    spawnSyncMock.mockReturnValue({ status: 0 });
    await pi.spawn!(["--model", "claude-haiku-4-5"], ROUTING);
    const call = spawnSyncMock.mock.calls[0]!;
    expect(call[1]).toEqual(["--provider", "opper", "--model", "claude-haiku-4-5"]);
  });

  it("spawn propagates non-zero exit codes", async () => {
    spawnSyncMock.mockReturnValue({ status: 2 });
    const code = await pi.spawn!([], ROUTING);
    expect(code).toBe(2);
  });

  it("unconfigure removes the opper provider", async () => {
    await pi.configure({ apiKey: "op_live_test" });
    expect(existsSync(join(sandbox, ".pi", "agent", "models.json"))).toBe(true);
    await pi.unconfigure();
    const models = readModels(sandbox);
    expect(models.providers?.opper).toBeUndefined();
  });
});
