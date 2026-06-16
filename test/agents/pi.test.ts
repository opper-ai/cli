import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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

function agentDir(sandbox: string): string {
  return join(sandbox, ".pi", "agent");
}
function modelsPath(sandbox: string): string {
  return join(agentDir(sandbox), "models.json");
}
function extPath(sandbox: string): string {
  return join(agentDir(sandbox), "extensions", "opper-session.ts");
}
function readModels(sandbox: string): {
  providers?: Record<string, { baseUrl?: string; apiKey?: string; headers?: unknown }>;
} {
  return JSON.parse(readFileSync(modelsPath(sandbox), "utf8"));
}

describe("pi adapter", () => {
  let sandbox: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    whichMock.mockReset();
    runMock.mockReset();
    whichMock.mockResolvedValue("/usr/bin/pi");
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === "--version") return { code: 0, stdout: "pi 0.79.4" };
      return { code: 0, stdout: "" };
    });
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
    await expect(pi.configure({})).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("configure with apiKey writes the default compat URL into the real models.json", async () => {
    await pi.configure({ apiKey: "op_live_test" });
    const models = readModels(sandbox);
    expect(models.providers?.opper?.baseUrl).toBe("https://api.opper.ai/v3/compat");
    expect(models.providers?.opper?.apiKey).toBe("op_live_test");
    // No static trace headers — those are added per session by the extension.
    expect(models.providers?.opper?.headers).toBeUndefined();
  });

  it("spawn writes the session URL AND ships the extension mid-launch", async () => {
    let mid: { models: ReturnType<typeof readModels>; extExists: boolean; ext: string } | undefined;
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === "--version") return { code: 0, stdout: "pi 0.79.4" };
      mid = {
        models: readModels(sandbox),
        extExists: existsSync(extPath(sandbox)),
        ext: existsSync(extPath(sandbox)) ? readFileSync(extPath(sandbox), "utf8") : "",
      };
      return { code: 0, stdout: "" };
    });

    const code = await pi.spawn!([], ROUTING);
    expect(code).toBe(0);
    expect(mid?.models.providers?.opper?.baseUrl).toBe(SESSION_URL);
    expect(mid?.extExists).toBe(true);
    expect(mid?.ext).toContain("session_start");
    expect(mid?.ext).toContain("registerProvider");
    expect(mid?.ext).toContain("X-Opper-Trace-Id");
  });

  it("spawn runs pi against the real home with key + base url in the env", async () => {
    await pi.spawn!([], ROUTING);
    const call = runMock.mock.calls.find((c) => c[0] === "pi" && c[1]?.[0] !== "--version");
    const [, args, opts] = call!;
    expect(args).toEqual(["--provider", "opper", "--model", "claude-opus-4-7"]);
    expect(opts.inherit).toBe(true);
    expect(opts.env.OPPER_API_KEY).toBe("op_live_run");
    expect(opts.env.OPPER_BASE_URL).toBe(SESSION_URL);
    // We do NOT isolate — no PI_CODING_AGENT_DIR override.
    expect(opts.env.PI_CODING_AGENT_DIR).toBeUndefined();
  });

  it("spawn restores config and removes the extension on exit (one-off launch leaves nothing)", async () => {
    expect(existsSync(modelsPath(sandbox))).toBe(false);
    await pi.spawn!([], ROUTING);
    // No pre-existing config → models.json removed, extension gone.
    expect(existsSync(modelsPath(sandbox))).toBe(false);
    expect(existsSync(extPath(sandbox))).toBe(false);
  });

  it("spawn restores the pre-launch config and a pre-existing extension", async () => {
    await pi.configure({ apiKey: "op_user_key" });
    mkdirSync(join(agentDir(sandbox), "extensions"), { recursive: true });
    writeFileSync(extPath(sandbox), "// user's own extension\n", "utf8");
    const beforeModels = readFileSync(modelsPath(sandbox), "utf8");

    await pi.spawn!([], ROUTING);

    expect(readFileSync(modelsPath(sandbox), "utf8")).toBe(beforeModels);
    expect(readFileSync(extPath(sandbox), "utf8")).toBe("// user's own extension\n");
  });

  it("spawn preserves sibling providers edited mid-launch", async () => {
    await pi.configure({ apiKey: "op_user_key" });
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === "--version") return { code: 0, stdout: "pi 0.79.4" };
      const cur = JSON.parse(readFileSync(modelsPath(sandbox), "utf8")) as {
        providers?: Record<string, unknown>;
      };
      cur.providers = cur.providers ?? {};
      cur.providers["lmstudio"] = { baseUrl: "http://localhost:1234" };
      writeFileSync(modelsPath(sandbox), JSON.stringify(cur, null, 2) + "\n", "utf8");
      return { code: 0, stdout: "" };
    });

    await pi.spawn!([], ROUTING);
    const after = readModels(sandbox);
    expect(after.providers?.lmstudio).toEqual({ baseUrl: "http://localhost:1234" });
    expect(after.providers?.opper?.baseUrl).toBe("https://api.opper.ai/v3/compat");
  });

  it("spawn does not auto-inject --model when the user passes one", async () => {
    await pi.spawn!(["--model", "claude-haiku-4-5"], ROUTING);
    const call = runMock.mock.calls.find((c) => c[0] === "pi" && c[1]?.[0] !== "--version");
    expect(call![1]).toEqual(["--provider", "opper", "--model", "claude-haiku-4-5"]);
  });

  it("spawn propagates non-zero exit codes", async () => {
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === "--version") return { code: 0, stdout: "pi 0.79.4" };
      return { code: 17, stdout: "" };
    });
    expect(await pi.spawn!([], ROUTING)).toBe(17);
  });

  it("unconfigure removes the opper provider and any leftover extension", async () => {
    await pi.configure({ apiKey: "op_live_test" });
    mkdirSync(join(agentDir(sandbox), "extensions"), { recursive: true });
    writeFileSync(extPath(sandbox), "// leftover\n", "utf8");

    await pi.unconfigure();
    expect(readModels(sandbox).providers?.opper).toBeUndefined();
    expect(existsSync(extPath(sandbox))).toBe(false);
  });
});
