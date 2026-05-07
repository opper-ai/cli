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

  it("spawn writes routing.baseUrl (the session URL) into models.json before launching", async () => {
    spawnSyncMock.mockReturnValue({ status: 0 });

    const code = await pi.spawn!(["chat"], ROUTING);
    expect(code).toBe(0);

    const models = readModels(sandbox);
    expect(models.providers?.opper?.baseUrl).toBe(SESSION_URL);
    expect(models.providers?.opper?.apiKey).toBe("op_live_run");

    const raw = readFileSync(
      join(sandbox, ".pi", "agent", "models.json"),
      "utf8",
    );
    expect(raw).not.toContain('"baseUrl": "https://api.opper.ai/v3/compat"');
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
