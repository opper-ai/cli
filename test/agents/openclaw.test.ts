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

  it("spawn writes routing.baseUrl (the session URL) into models.json before launching", async () => {
    spawnSyncMock.mockReturnValue({ status: 0 });

    const code = await openclaw.spawn!(["agent"], ROUTING);
    expect(code).toBe(0);

    const models = readModels(sandbox);
    expect(models.providers?.opper?.baseUrl).toBe(SESSION_URL);
    expect(models.providers?.opper?.apiKey).toBe("op_live_run");

    // The default compat URL should NOT have leaked into the file.
    const raw = readFileSync(
      join(sandbox, ".openclaw", "agents", "main", "agent", "models.json"),
      "utf8",
    );
    expect(raw).not.toContain('"baseUrl": "https://api.opper.ai/v3/compat"');
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
