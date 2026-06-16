import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const whichMock = vi.fn();
const runMock = vi.fn();
vi.mock("../../src/util/which.js", () => ({ which: whichMock }));
vi.mock("../../src/util/run.js", () => ({ run: runMock }));

const { pi } = await import("../../src/agents/pi.js");

const SESSION_URL =
  "https://api.opper.ai/v3/session/sess_aa11bb22-cccc-4ddd-8eee-ffff00001111/customer:acme";

const ROUTING = {
  baseUrl: SESSION_URL,
  apiKey: "op_live_run",
  model: "claude-opus-4-7",
  compatShape: "openai" as const,
};

function piHomeDir(sandbox: string): string {
  return join(sandbox, ".opper", "pi-home");
}
function readModels(sandbox: string): {
  providers?: Record<
    string,
    { api?: string; apiKey?: string; baseUrl?: string; headers?: unknown; models?: Array<{ id: string; _launch?: boolean }> }
  >;
} {
  return JSON.parse(readFileSync(join(piHomeDir(sandbox), "models.json"), "utf8"));
}

describe("pi adapter", () => {
  let sandbox: string;
  let prevHome: string | undefined;
  let prevOpperHome: string | undefined;

  beforeEach(() => {
    whichMock.mockReset();
    runMock.mockReset();
    // Installed by default; --version probe returns a version.
    whichMock.mockResolvedValue("/usr/bin/pi");
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === "--version") return { code: 0, stdout: "pi 0.79.4" };
      return { code: 0, stdout: "" };
    });
    sandbox = mkdtempSync(join(tmpdir(), "opper-pi-"));
    prevHome = process.env.HOME;
    prevOpperHome = process.env.OPPER_HOME;
    process.env.HOME = sandbox;
    process.env.OPPER_HOME = join(sandbox, ".opper");
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevOpperHome === undefined) delete process.env.OPPER_HOME;
    else process.env.OPPER_HOME = prevOpperHome;
  });

  it("metadata is correct", () => {
    expect(pi.name).toBe("pi");
    expect(pi.displayName).toBe("Pi");
    expect(typeof pi.spawn).toBe("function");
    expect(typeof pi.install).toBe("function");
  });

  it("configure throws AGENT_NOT_FOUND when pi is not installed", async () => {
    whichMock.mockResolvedValue(null);
    await expect(pi.configure({})).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  it("configure resolves when pi is installed", async () => {
    await expect(pi.configure({})).resolves.toBeUndefined();
  });

  it("spawn writes the opper provider into the ISOLATED pi home (session URL, no key on disk)", async () => {
    const code = await pi.spawn!([], ROUTING);
    expect(code).toBe(0);

    const models = readModels(sandbox);
    const opper = models.providers?.opper;
    expect(opper?.api).toBe("openai-completions");
    expect(opper?.baseUrl).toBe(SESSION_URL);
    // The real key never lands on disk — only the env reference does.
    expect(opper?.apiKey).toBe("$OPPER_API_KEY");
    expect(JSON.stringify(models)).not.toContain("op_live_run");
    // No static trace headers in the config — the extension adds them per session.
    expect(opper?.headers).toBeUndefined();
  });

  it("spawn ships the session extension into the isolated home", async () => {
    await pi.spawn!([], ROUTING);
    const extPath = join(piHomeDir(sandbox), "extensions", "opper-session.ts");
    expect(existsSync(extPath)).toBe(true);
    const ext = readFileSync(extPath, "utf8");
    expect(ext).toContain("session_start");
    expect(ext).toContain("registerProvider");
    expect(ext).toContain("X-Opper-Trace-Id");
  });

  it("spawn places the launch model at models[0] with _launch", async () => {
    await pi.spawn!([], { ...ROUTING, model: "claude-haiku-4-5" });
    const list = readModels(sandbox).providers?.opper?.models ?? [];
    expect(list[0]?.id).toBe("claude-haiku-4-5");
    expect(list[0]?._launch).toBe(true);
    expect(list.length).toBeGreaterThan(1);
  });

  it("spawn runs pi against the isolated home with key + base url in the env", async () => {
    await pi.spawn!([], ROUTING);
    const call = runMock.mock.calls.find((c) => c[0] === "pi" && c[1]?.[0] !== "--version");
    expect(call).toBeDefined();
    const [, args, opts] = call!;
    expect(args).toEqual(["--provider", "opper", "--model", "claude-opus-4-7"]);
    expect(opts.inherit).toBe(true);
    expect(opts.env.PI_CODING_AGENT_DIR).toBe(piHomeDir(sandbox));
    expect(opts.env.OPPER_API_KEY).toBe("op_live_run");
    expect(opts.env.OPPER_BASE_URL).toBe(SESSION_URL);
  });

  it("spawn does not auto-inject --model when the user passes one", async () => {
    await pi.spawn!(["--model", "claude-haiku-4-5"], ROUTING);
    const call = runMock.mock.calls.find((c) => c[0] === "pi" && c[1]?.[0] !== "--version");
    expect(call![1]).toEqual(["--provider", "opper", "--model", "claude-haiku-4-5"]);
  });

  it("spawn never touches the user's real ~/.pi", async () => {
    await pi.spawn!([], ROUTING);
    expect(existsSync(join(sandbox, ".pi"))).toBe(false);
  });

  it("spawn propagates non-zero exit codes", async () => {
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === "--version") return { code: 0, stdout: "pi 0.79.4" };
      return { code: 17, stdout: "" };
    });
    const code = await pi.spawn!([], ROUTING);
    expect(code).toBe(17);
  });
});
