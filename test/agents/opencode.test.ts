import { describe, it, expect, vi, beforeEach } from "vitest";

const whichMock = vi.fn();
vi.mock("../../src/util/which.js", () => ({ which: whichMock }));

const runMock = vi.fn();
vi.mock("../../src/util/run.js", () => ({ run: runMock }));

const configureOpenCodeMock = vi.fn();
const readProjectConfigStateMock = vi.fn();
vi.mock("../../src/setup/opencode.js", () => ({
  configureOpenCode: configureOpenCodeMock,
  readProjectConfigState: readProjectConfigStateMock,
}));

const spawnSyncMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return { ...actual, spawnSync: spawnSyncMock };
});

const { opencode } = await import("../../src/agents/opencode.js");

const ROUTING = {
  baseUrl: "https://api.opper.ai/v3/compat",
  apiKey: "op_live_run",
  model: "claude-opus-4-7",
  compatShape: "openai" as const,
};

describe("opencode adapter", () => {
  beforeEach(() => {
    whichMock.mockReset();
    runMock.mockReset();
    configureOpenCodeMock.mockReset();
    readProjectConfigStateMock.mockReset();
    spawnSyncMock.mockReset();
    // Default: no shadowing project config exists.
    readProjectConfigStateMock.mockReturnValue({
      exists: false,
      hasOpperProvider: false,
    });
  });

  it("metadata is correct", () => {
    expect(opencode.name).toBe("opencode");
    expect(opencode.displayName).toBe("OpenCode");
    expect(opencode.docsUrl).toMatch(/^https:\/\//);
    expect(typeof opencode.spawn).toBe("function");
    expect(typeof opencode.install).toBe("function");
  });

  it("install runs `npm i -g opencode-ai` with inherited stdio and resolves on exit 0", async () => {
    whichMock.mockResolvedValue("/usr/bin/npm");
    runMock.mockReturnValue({ code: 0, stdout: "", stderr: "" });
    await expect(opencode.install!()).resolves.toBeUndefined();
    expect(runMock).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = runMock.mock.calls[0]!;
    expect(cmd).toMatch(/^npm(\.cmd)?$/);
    expect(args).toEqual(["install", "-g", "opencode-ai"]);
    expect(options).toMatchObject({ inherit: true });
  });

  it("install throws OpperError(AGENT_NOT_FOUND) when npm exits non-zero", async () => {
    whichMock.mockResolvedValue("/usr/bin/npm");
    runMock.mockReturnValue({ code: 1, stdout: "", stderr: "boom" });
    await expect(opencode.install!()).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  });

  it("detect returns installed=false when opencode not on PATH", async () => {
    whichMock.mockResolvedValue(null);
    const result = await opencode.detect();
    expect(result.installed).toBe(false);
  });

  it("detect returns installed=true when binary found", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/opencode");
    const result = await opencode.detect();
    expect(result.installed).toBe(true);
  });

  it("spawn ensures the provider config exists then runs opencode with OPPER_API_KEY in env", async () => {
    configureOpenCodeMock.mockResolvedValue({
      path: "/tmp/opencode.json",
      wrote: true,
    });
    spawnSyncMock.mockReturnValue({ status: 0 });

    const code = await opencode.spawn!(["chat"], ROUTING);
    expect(code).toBe(0);
    expect(configureOpenCodeMock).toHaveBeenCalledWith({ location: "global" });

    const call = spawnSyncMock.mock.calls[0]!;
    expect(call[0]).toBe("opencode");
    expect(call[1]).toEqual(["chat"]);
    const init = call[2] as { env: NodeJS.ProcessEnv };
    expect(init.env.OPPER_API_KEY).toBe("op_live_run");
  });

  it("spawn propagates non-zero exit codes", async () => {
    configureOpenCodeMock.mockResolvedValue({ path: "/tmp/x", wrote: false });
    spawnSyncMock.mockReturnValue({ status: 2 });
    const code = await opencode.spawn!([], ROUTING);
    expect(code).toBe(2);
  });

  it("spawn writes to the project config when configScope=project", async () => {
    configureOpenCodeMock.mockResolvedValue({ path: "./opencode.json", wrote: true });
    spawnSyncMock.mockReturnValue({ status: 0 });

    await opencode.spawn!(["chat"], ROUTING, { configScope: "project" });
    expect(configureOpenCodeMock).toHaveBeenCalledWith({ location: "local" });
  });

  it("spawn warns when a project opencode.json exists without an Opper provider", async () => {
    configureOpenCodeMock.mockResolvedValue({ path: "/tmp/g", wrote: true });
    spawnSyncMock.mockReturnValue({ status: 0 });
    readProjectConfigStateMock.mockReturnValue({
      exists: true,
      hasOpperProvider: false,
    });

    const errors: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      errors.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      await opencode.spawn!([], ROUTING);
    } finally {
      process.stderr.write = orig;
    }

    const blob = errors.join("");
    expect(blob).toMatch(/opencode\.json/);
    expect(blob).toMatch(/--project/);
  });

  it("spawn does not warn when the project opencode.json already has an Opper provider", async () => {
    configureOpenCodeMock.mockResolvedValue({ path: "/tmp/g", wrote: true });
    spawnSyncMock.mockReturnValue({ status: 0 });
    readProjectConfigStateMock.mockReturnValue({
      exists: true,
      hasOpperProvider: true,
    });

    const errors: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      errors.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      await opencode.spawn!([], ROUTING);
    } finally {
      process.stderr.write = orig;
    }

    expect(errors.join("")).not.toMatch(/--project/);
  });

  it("spawn does not warn when configScope=project (we're writing there)", async () => {
    configureOpenCodeMock.mockResolvedValue({ path: "./opencode.json", wrote: true });
    spawnSyncMock.mockReturnValue({ status: 0 });
    readProjectConfigStateMock.mockReturnValue({
      exists: true,
      hasOpperProvider: false,
    });

    const errors: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      errors.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      await opencode.spawn!([], ROUTING, { configScope: "project" });
    } finally {
      process.stderr.write = orig;
    }

    expect(errors.join("")).not.toMatch(/--project/);
  });
});
