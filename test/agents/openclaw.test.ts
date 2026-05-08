import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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

const { openclaw } = await import("../../src/agents/openclaw.js");

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
  const cfgPath = join(sandbox, ".openclaw", "agents", "main", "agent", "models.json");
  return JSON.parse(readFileSync(cfgPath, "utf8"));
}

describe("openclaw adapter", () => {
  let sandbox: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    whichMock.mockReset();
    runMock.mockReset();
    spawnSyncMock.mockReset();
    sandbox = mkdtempSync(join(tmpdir(), "opper-openclaw-"));
    prevHome = process.env.HOME;
    process.env.HOME = sandbox;
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });

  it("metadata is correct", () => {
    expect(openclaw.name).toBe("openclaw");
    expect(openclaw.displayName).toBe("OpenClaw");
    expect(typeof openclaw.spawn).toBe("function");
    expect(typeof openclaw.install).toBe("function");
  });

  it("configure (no apiKey) throws AUTH_REQUIRED", async () => {
    await expect(openclaw.configure({})).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });

  it("configure with apiKey writes the default compat URL into models.json", async () => {
    await openclaw.configure({ apiKey: "op_live_test" });
    const models = readModels(sandbox);
    expect(models.providers?.opper).toBeDefined();
    expect(models.providers?.opper?.baseUrl).toBe(
      "https://api.opper.ai/v3/compat",
    );
    expect(models.providers?.opper?.apiKey).toBe("op_live_test");
  });

  it("spawn writes routing.baseUrl (the session URL) into models.json mid-launch", async () => {
    // Mid-spawn the session URL is the active baseUrl. We capture inside
    // the spawn callback because we restore the file on exit.
    const cfgPath = join(
      sandbox, ".openclaw", "agents", "main", "agent", "models.json",
    );
    let midRun: ReturnType<typeof readModels> | undefined;
    spawnSyncMock.mockImplementation(() => {
      midRun = JSON.parse(readFileSync(cfgPath, "utf8"));
      return { status: 0 };
    });

    const code = await openclaw.spawn!(["agent"], ROUTING);
    expect(code).toBe(0);

    expect(midRun?.providers?.opper?.baseUrl).toBe(SESSION_URL);
    expect(midRun?.providers?.opper?.apiKey).toBe("op_live_run");
  });

  it("spawn restores the pre-launch config so direct `openclaw` runs don't inherit the session URL", async () => {
    await openclaw.configure({ apiKey: "op_user_key" });
    const cfgPath = join(
      sandbox, ".openclaw", "agents", "main", "agent", "models.json",
    );
    const before = readFileSync(cfgPath, "utf8");

    spawnSyncMock.mockReturnValue({ status: 0 });
    await openclaw.spawn!(["agent"], ROUTING);

    expect(readFileSync(cfgPath, "utf8")).toBe(before);
  });

  it("spawn deletes the config it created when none existed before", async () => {
    const cfgPath = join(
      sandbox, ".openclaw", "agents", "main", "agent", "models.json",
    );
    expect(existsSync(cfgPath)).toBe(false);

    spawnSyncMock.mockReturnValue({ status: 0 });
    await openclaw.spawn!(["agent"], ROUTING);

    expect(existsSync(cfgPath)).toBe(false);
  });

  it("spawn restores the pre-launch config even on non-zero exit", async () => {
    await openclaw.configure({ apiKey: "op_user_key" });
    const cfgPath = join(
      sandbox, ".openclaw", "agents", "main", "agent", "models.json",
    );
    const before = readFileSync(cfgPath, "utf8");

    spawnSyncMock.mockReturnValue({ status: 17 });
    const code = await openclaw.spawn!(["agent"], ROUTING);
    expect(code).toBe(17);
    expect(readFileSync(cfgPath, "utf8")).toBe(before);
  });

  it("spawn restore preserves sibling providers / top-level edits made mid-spawn", async () => {
    await openclaw.configure({ apiKey: "op_user_key" });
    const cfgPath = join(
      sandbox, ".openclaw", "agents", "main", "agent", "models.json",
    );

    spawnSyncMock.mockImplementation(() => {
      const cur = JSON.parse(readFileSync(cfgPath, "utf8")) as {
        providers?: Record<string, unknown>;
        userKey?: string;
      };
      cur.providers = cur.providers ?? {};
      cur.providers["custom"] = { baseUrl: "https://example.com" };
      cur.userKey = "preserved";
      writeFileSync(cfgPath, JSON.stringify(cur, null, 2) + "\n", "utf8");
      return { status: 0 };
    });

    await openclaw.spawn!(["agent"], ROUTING);

    const after = JSON.parse(readFileSync(cfgPath, "utf8")) as {
      providers?: Record<string, { baseUrl?: string }>;
      userKey?: string;
    };
    expect(after.providers?.custom).toEqual({ baseUrl: "https://example.com" });
    expect(after.userKey).toBe("preserved");
    expect(after.providers?.opper?.baseUrl).toBe("https://api.opper.ai/v3/compat");
  });

  it("spawn places the launch model at models[0] even when it isn't opus", async () => {
    spawnSyncMock.mockReturnValue({ status: 0 });
    await openclaw.spawn!([], { ...ROUTING, model: "gpt-5.5" });

    const models = readModels(sandbox) as {
      providers?: { opper?: { models?: Array<{ id: string }> } };
    };
    const list = models.providers?.opper?.models ?? [];
    // OpenClaw has no _launch marker — position 0 is the only signal.
    expect(list[0]?.id).toBe("gpt-5.5");
    expect(list.length).toBeGreaterThan(1);
    expect(list.some((m) => m.id === "claude-opus-4-7")).toBe(true);
  });

  it("spawn defaults to `gateway start` when no args are passed", async () => {
    spawnSyncMock.mockReturnValue({ status: 0 });
    await openclaw.spawn!([], ROUTING);
    const call = spawnSyncMock.mock.calls[0]!;
    expect(call[0]).toBe("openclaw");
    expect(call[1]).toEqual(["gateway", "start"]);
  });

  it("spawn does NOT snapshot the config on the daemon path — the gateway daemon outlives spawnSync and owns the file from then on", async () => {
    spawnSyncMock.mockReturnValue({ status: 0 });
    await openclaw.spawn!([], ROUTING);
    // Post-spawn, models.json keeps the session URL: the daemon is
    // running, will keep using whatever URL it loaded, and the file
    // mirrors that. Restoring would either break the live daemon or
    // be cosmetic — neither is correct.
    const models = readModels(sandbox);
    expect(models.providers?.opper?.baseUrl).toBe(SESSION_URL);
  });

  it("spawn does NOT snapshot when the user explicitly passes `gateway start`", async () => {
    // `opper launch openclaw -- gateway start` is the daemon path too
    // — same semantics as the no-args default. We must not gate on
    // arg-count alone.
    spawnSyncMock.mockReturnValue({ status: 0 });
    await openclaw.spawn!(["gateway", "start"], ROUTING);
    const models = readModels(sandbox);
    expect(models.providers?.opper?.baseUrl).toBe(SESSION_URL);
  });

  it("spawn does NOT snapshot when the user explicitly passes `daemon start`", async () => {
    spawnSyncMock.mockReturnValue({ status: 0 });
    await openclaw.spawn!(["daemon", "start"], ROUTING);
    const models = readModels(sandbox);
    expect(models.providers?.opper?.baseUrl).toBe(SESSION_URL);
  });

  it("spawn forwards user-supplied args verbatim", async () => {
    spawnSyncMock.mockReturnValue({ status: 0 });
    await openclaw.spawn!(["agent", "--local"], ROUTING);
    const call = spawnSyncMock.mock.calls[0]!;
    expect(call[1]).toEqual(["agent", "--local"]);
  });

  it("spawn propagates non-zero exit codes", async () => {
    spawnSyncMock.mockReturnValue({ status: 2 });
    const code = await openclaw.spawn!(["agent"], ROUTING);
    expect(code).toBe(2);
  });

  it("unconfigure removes the opper provider but leaves the file/other providers", async () => {
    await openclaw.configure({ apiKey: "op_live_test" });
    expect(existsSync(
      join(sandbox, ".openclaw", "agents", "main", "agent", "models.json"),
    )).toBe(true);
    await openclaw.unconfigure();
    const models = readModels(sandbox);
    expect(models.providers?.opper).toBeUndefined();
  });
});
