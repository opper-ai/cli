import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const SESSION_URL =
  "https://api.opper.ai/v3/session/sess_aa11bb22-cccc-4ddd-8eee-ffff00001111/customer:acme";

const ROUTING = {
  baseUrl: SESSION_URL,
  apiKey: "op_live_run",
  model: "claude-opus-4-7",
  compatShape: "openai" as const,
};

function opencodeConfigPath(sandbox: string): string {
  return join(sandbox, ".config", "opencode", "opencode.json");
}

function seedOpencodeConfig(sandbox: string): void {
  const cfgPath = opencodeConfigPath(sandbox);
  mkdirSync(join(sandbox, ".config", "opencode"), { recursive: true });
  writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        provider: {
          opper: {
            npm: "@ai-sdk/openai-compatible",
            options: {
              baseURL: "https://api.opper.ai/v3/compat",
              apiKey: "{env:OPPER_API_KEY}",
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

describe("opencode adapter", () => {
  let sandbox: string;
  let prevHome: string | undefined;

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
    sandbox = mkdtempSync(join(tmpdir(), "opper-opencode-"));
    prevHome = process.env.HOME;
    process.env.HOME = sandbox;
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
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
      path: opencodeConfigPath(sandbox),
      wrote: true,
    });
    spawnSyncMock.mockReturnValue({ status: 0 });
    seedOpencodeConfig(sandbox);

    const code = await opencode.spawn!(["chat"], ROUTING);
    expect(code).toBe(0);
    expect(configureOpenCodeMock).toHaveBeenCalledWith({ location: "global", overwrite: true });

    const call = spawnSyncMock.mock.calls[0]!;
    expect(call[0]).toBe("opencode");
    expect(call[1]).toEqual(["chat"]);
    const init = call[2] as { env: NodeJS.ProcessEnv };
    expect(init.env.OPPER_API_KEY).toBe("op_live_run");
  });

  it("spawn rewrites provider.opper.options.baseURL to routing.baseUrl mid-launch", async () => {
    configureOpenCodeMock.mockResolvedValue({
      path: opencodeConfigPath(sandbox),
      wrote: false,
    });
    seedOpencodeConfig(sandbox);

    // Mid-spawn the session URL is the active baseURL — we capture
    // inside the spawn callback because we restore on exit.
    let midRun: {
      provider: { opper: { options: { baseURL: string; apiKey: string } } };
    } | undefined;
    spawnSyncMock.mockImplementation(() => {
      midRun = JSON.parse(readFileSync(opencodeConfigPath(sandbox), "utf8"));
      return { status: 0 };
    });

    await opencode.spawn!([], ROUTING);

    expect(midRun?.provider.opper.options.baseURL).toBe(SESSION_URL);
    // The {env:OPPER_API_KEY} placeholder is preserved — we only rewrote
    // baseURL.
    expect(midRun?.provider.opper.options.apiKey).toBe("{env:OPPER_API_KEY}");
  });

  it("spawn restores the pre-launch opencode.json so direct `opencode` runs don't inherit the session URL", async () => {
    configureOpenCodeMock.mockResolvedValue({
      path: opencodeConfigPath(sandbox),
      wrote: false,
    });
    spawnSyncMock.mockReturnValue({ status: 0 });
    seedOpencodeConfig(sandbox);
    const before = readFileSync(opencodeConfigPath(sandbox), "utf8");

    await opencode.spawn!([], ROUTING);

    expect(readFileSync(opencodeConfigPath(sandbox), "utf8")).toBe(before);
  });

  it("spawn deletes any opencode.json it caused to be created when none existed before", async () => {
    // Simulate `configureOpenCode` writing the template config from
    // scratch — the real implementation does this on first launch.
    const cfg = opencodeConfigPath(sandbox);
    expect(existsSync(cfg)).toBe(false);
    configureOpenCodeMock.mockImplementation(async () => {
      mkdirSync(join(sandbox, ".config", "opencode"), { recursive: true });
      writeFileSync(
        cfg,
        JSON.stringify({
          provider: {
            opper: {
              npm: "@ai-sdk/openai-compatible",
              options: {
                baseURL: "https://api.opper.ai/v3/compat",
                apiKey: "{env:OPPER_API_KEY}",
              },
            },
          },
        }),
        "utf8",
      );
      return { path: cfg, wrote: true };
    });
    spawnSyncMock.mockReturnValue({ status: 0 });

    await opencode.spawn!([], ROUTING);

    expect(existsSync(cfg)).toBe(false);
  });

  it("spawn restores the pre-launch config even on non-zero exit", async () => {
    configureOpenCodeMock.mockResolvedValue({
      path: opencodeConfigPath(sandbox),
      wrote: false,
    });
    seedOpencodeConfig(sandbox);
    const before = readFileSync(opencodeConfigPath(sandbox), "utf8");

    spawnSyncMock.mockReturnValue({ status: 17 });
    const code = await opencode.spawn!([], ROUTING);
    expect(code).toBe(17);
    expect(readFileSync(opencodeConfigPath(sandbox), "utf8")).toBe(before);
  });

  it("spawn does not crash if the opencode.json doesn't exist yet (configureOpenCode was a no-op stub)", async () => {
    configureOpenCodeMock.mockResolvedValue({
      path: opencodeConfigPath(sandbox),
      wrote: false,
    });
    spawnSyncMock.mockReturnValue({ status: 0 });
    // No seedOpencodeConfig — config is missing.
    const code = await opencode.spawn!([], ROUTING);
    expect(code).toBe(0);
  });

  it("spawn propagates non-zero exit codes", async () => {
    configureOpenCodeMock.mockResolvedValue({
      path: opencodeConfigPath(sandbox),
      wrote: false,
    });
    spawnSyncMock.mockReturnValue({ status: 2 });
    seedOpencodeConfig(sandbox);
    const code = await opencode.spawn!([], ROUTING);
    expect(code).toBe(2);
  });

  it("spawn writes to the project config when configScope=project", async () => {
    configureOpenCodeMock.mockResolvedValue({ path: "./opencode.json", wrote: true });
    spawnSyncMock.mockReturnValue({ status: 0 });

    await opencode.spawn!(["chat"], ROUTING, { configScope: "project" });
    expect(configureOpenCodeMock).toHaveBeenCalledWith({ location: "local", overwrite: true });
  });

  it("project scope: opper provider persists across launches but baseURL is reset to compat", async () => {
    // `--project` is opt-in to a checked-in config — the opper provider
    // should stay. Only the session URL should not leak.
    const prevCwd = process.cwd();
    process.chdir(sandbox);
    try {
      const projectCfg = join(sandbox, "opencode.json");
      configureOpenCodeMock.mockImplementation(async () => {
        writeFileSync(
          projectCfg,
          JSON.stringify({
            provider: {
              opper: {
                npm: "@ai-sdk/openai-compatible",
                options: {
                  baseURL: "https://api.opper.ai/v3/compat",
                  apiKey: "{env:OPPER_API_KEY}",
                },
              },
            },
          }, null, 2),
          "utf8",
        );
        return { path: projectCfg, wrote: true };
      });

      let midRunBaseUrl: string | undefined;
      spawnSyncMock.mockImplementation(() => {
        midRunBaseUrl = (
          JSON.parse(readFileSync(projectCfg, "utf8")) as {
            provider: { opper: { options: { baseURL: string } } };
          }
        ).provider.opper.options.baseURL;
        return { status: 0 };
      });

      await opencode.spawn!([], ROUTING, { configScope: "project" });
      expect(midRunBaseUrl).toBe(SESSION_URL);

      // Post-spawn: opper provider still there, baseURL reset to compat.
      const after = JSON.parse(readFileSync(projectCfg, "utf8")) as {
        provider: { opper: { options: { baseURL: string } } };
      };
      expect(after.provider.opper.options.baseURL).toBe(
        "https://api.opper.ai/v3/compat",
      );
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("project scope: a hand-edited custom baseURL is preserved across launches", async () => {
    // Self-hosted Opper / staging users may pin a custom baseURL in
    // their checked-in opencode.json. The launch should swap to the
    // session URL during spawn and restore *that* custom URL on exit,
    // not blindly reset to the public compat URL.
    const prevCwd = process.cwd();
    process.chdir(sandbox);
    try {
      const projectCfg = join(sandbox, "opencode.json");
      const customBaseUrl = "https://opper.internal.example.com/v3/compat";
      writeFileSync(
        projectCfg,
        JSON.stringify({
          provider: {
            opper: {
              npm: "@ai-sdk/openai-compatible",
              options: {
                baseURL: customBaseUrl,
                apiKey: "{env:OPPER_API_KEY}",
              },
            },
          },
        }, null, 2),
        "utf8",
      );
      // configureOpenCode is a no-op when an opper provider already
      // exists (see src/setup/opencode.ts:80-82).
      configureOpenCodeMock.mockResolvedValue({
        path: projectCfg, wrote: false, reason: "exists" as const,
      });
      spawnSyncMock.mockReturnValue({ status: 0 });

      await opencode.spawn!([], ROUTING, { configScope: "project" });

      const after = JSON.parse(readFileSync(projectCfg, "utf8")) as {
        provider: { opper: { options: { baseURL: string } } };
      };
      expect(after.provider.opper.options.baseURL).toBe(customBaseUrl);
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("project scope: baseURL is reset even when the agent exits non-zero", async () => {
    const prevCwd = process.cwd();
    process.chdir(sandbox);
    try {
      const projectCfg = join(sandbox, "opencode.json");
      configureOpenCodeMock.mockImplementation(async () => {
        writeFileSync(
          projectCfg,
          JSON.stringify({
            provider: {
              opper: {
                npm: "@ai-sdk/openai-compatible",
                options: {
                  baseURL: "https://api.opper.ai/v3/compat",
                  apiKey: "{env:OPPER_API_KEY}",
                },
              },
            },
          }, null, 2),
          "utf8",
        );
        return { path: projectCfg, wrote: true };
      });
      spawnSyncMock.mockReturnValue({ status: 17 });

      const code = await opencode.spawn!([], ROUTING, { configScope: "project" });
      expect(code).toBe(17);

      const after = JSON.parse(readFileSync(projectCfg, "utf8")) as {
        provider: { opper: { options: { baseURL: string } } };
      };
      expect(after.provider.opper.options.baseURL).toBe(
        "https://api.opper.ai/v3/compat",
      );
    } finally {
      process.chdir(prevCwd);
    }
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
