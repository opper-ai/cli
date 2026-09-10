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
import { parse, type ParseError } from "jsonc-parser";

const whichMock = vi.fn();
vi.mock("../../src/util/which.js", () => ({ which: whichMock }));

const runMock = vi.fn();
vi.mock("../../src/util/run.js", () => ({ run: runMock }));

const configureOpenCodeMock = vi.fn();
vi.mock("../../src/setup/opencode.js", () => ({
  configureOpenCode: configureOpenCodeMock,
}));

// spawn() and configure() resolve the live catalogue; stub it so this suite
// stays offline, and so a test can vary what the gateway "returns".
const resolveOpenCodeModelsMock = vi.fn().mockResolvedValue({});
vi.mock("../../src/setup/opencode-models.js", () => ({
  resolveOpenCodeModels: resolveOpenCodeModelsMock,
}));

const spawnSyncMock = vi.fn();
const debugConfigMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return { ...actual, spawnSync: (...args: any[]) =>
    args[0] === "opencode" && args[1]?.[0] === "debug" && args[1]?.[1] === "config"
      ? debugConfigMock(...args) : spawnSyncMock(...args) };
});

const { opencode } = await import("../../src/agents/opencode.js");

const SESSION_URL =
  "https://api.opper.ai/v3/session/sess_aa11bb22-cccc-4ddd-8eee-ffff00001111/customer:acme";

const ROUTING = {
  apiBaseUrl: "https://api.opper.ai",
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
  let prevEditorHome: string | undefined;

  beforeEach(() => {
    whichMock.mockReset();
    runMock.mockReset();
    configureOpenCodeMock.mockReset();
    spawnSyncMock.mockReset();
    debugConfigMock.mockReset().mockReturnValue({ status: 0, stdout: "{}", stderr: "" });
    sandbox = mkdtempSync(join(tmpdir(), "opper-opencode-"));
    prevHome = process.env.HOME;
    prevEditorHome = process.env.OPPER_EDITOR_HOME;
    process.env.HOME = sandbox;
    process.env.OPPER_EDITOR_HOME = sandbox;
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevEditorHome === undefined) delete process.env.OPPER_EDITOR_HOME;
    else process.env.OPPER_EDITOR_HOME = prevEditorHome;
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

  it("isConfigured recognizes a JSONC provider with comments and trailing commas", async () => {
    const configPath = opencodeConfigPath(sandbox);
    mkdirSync(join(sandbox, ".config", "opencode"), { recursive: true });
    const jsonc = `{
  // Existing user configuration.
  "provider": { "opper": { "name": "Opper", }, },
}\n`;
    writeFileSync(configPath, jsonc);

    await expect(opencode.isConfigured()).resolves.toBe(true);

    expect(readFileSync(configPath, "utf8")).toBe(jsonc);
  });

  it.each([
    { following: "provider", hasOtherProvider: true },
    { following: "top-level key", hasOtherProvider: false },
  ])("unconfigure preserves JSONC settings and the comment before the next $following", async ({ hasOtherProvider }) => {
    const configPath = opencodeConfigPath(sandbox);
    mkdirSync(join(sandbox, ".config", "opencode"), { recursive: true });
    const otherProvider = hasOtherProvider ? `
    // Keep the next provider's explanation.
    "other": { "name": "Other", },` : "";
    const jsonc = `{
  /* Personal configuration. */
  "provider": {
    "opper": { "name": "Opper", },${otherProvider}
  },
  // Keep the next setting's explanation.
  "theme": "tokyonight",
  "model": "other/selected-model",
  "mcp": { "docs": { "url": "https://docs.example.test/path//literal", }, },
}\n`;
    writeFileSync(configPath, jsonc);

    await opencode.unconfigure();

    const written = readFileSync(configPath, "utf8");
    const errors: ParseError[] = [];
    const config = parse(written, errors, { allowTrailingComma: true });
    expect(errors).toEqual([]);
    expect(config).toEqual({
      ...(hasOtherProvider ? { provider: { other: { name: "Other" } } } : {}),
      theme: "tokyonight",
      model: "other/selected-model",
      mcp: { docs: { url: "https://docs.example.test/path//literal" } },
    });
    expect.soft(written).toContain("/* Personal configuration. */");
    expect.soft(written).toContain("// Keep the next setting's explanation.");
    if (hasOtherProvider) {
      expect.soft(written).toContain("// Keep the next provider's explanation.");
    }
    await expect(opencode.isConfigured()).resolves.toBe(false);
  });

  it("unconfigure leaves ambiguous JSONC with duplicate provider keys unchanged", async () => {
    const configPath = opencodeConfigPath(sandbox);
    mkdirSync(join(sandbox, ".config", "opencode"), { recursive: true });
    const ambiguous = `{
  "provider": {
    "opper": { "name": "First Opper", },
    // The effective provider is ambiguous for a surgical edit.
    "opper": { "name": "Last Opper", },
    "other": { "name": "Other", },
  },
  "theme": "tokyonight",
}\n`;
    writeFileSync(configPath, ambiguous);

    await expect(opencode.unconfigure()).resolves.toBeUndefined();

    expect(readFileSync(configPath, "utf8")).toBe(ambiguous);
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
    expect(configureOpenCodeMock).toHaveBeenCalledWith({ location: "global", overwrite: true, models: {} });

    const call = spawnSyncMock.mock.calls[0]!;
    expect(call[0]).toBe("opencode");
    expect(call[1]).toEqual(["chat"]);
    const init = call[2] as { env: NodeJS.ProcessEnv };
    expect(init.env.OPPER_API_KEY).toBe("op_live_run");
  });

  it("spawn writes the live catalogue, so every launch refreshes the model list", async () => {
    // spawn() rewrites the config on every launch. If it did not pass the
    // fetched models through, `opper launch opencode` would keep writing the
    // frozen bundled list while `editors opencode` went dynamic.
    const models = { "dynamic/my-route": { name: "My Route (route)" } };
    resolveOpenCodeModelsMock.mockResolvedValueOnce(models);
    spawnSyncMock.mockReturnValue({ status: 0 });
    await opencode.spawn([], { ...ROUTING, apiKey: "k" });
    expect(configureOpenCodeMock).toHaveBeenCalledWith(
      expect.objectContaining({ models }),
    );
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
    const before = JSON.parse(readFileSync(opencodeConfigPath(sandbox), "utf8"));

    await opencode.spawn!([], ROUTING);

    expect(JSON.parse(readFileSync(opencodeConfigPath(sandbox), "utf8"))).toEqual(before);
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
    const before = JSON.parse(readFileSync(opencodeConfigPath(sandbox), "utf8"));

    spawnSyncMock.mockReturnValue({ status: 17 });
    const code = await opencode.spawn!([], ROUTING);
    expect(code).toBe(17);
    expect(JSON.parse(readFileSync(opencodeConfigPath(sandbox), "utf8"))).toEqual(before);
  });

  it("user scope: restore preserves non-Opper-owned sibling edits, reverts Opper-owned keys", async () => {
    // OpenCode mutates opencode.json during a session — themes, MCP
    // servers, etc. Narrow restore must:
    //   - revert provider.opper AND top-level model (both Opper-owned;
    //     the template writes both, and an orphaned `model: "opper/X"`
    //     pointing at a removed provider would break direct opencode
    //     runs after the launch);
    //   - leave non-Opper-owned siblings (theme, mcpServers, …) alone.
    configureOpenCodeMock.mockResolvedValue({
      path: opencodeConfigPath(sandbox),
      wrote: false,
    });
    seedOpencodeConfig(sandbox);
    const seedPath = opencodeConfigPath(sandbox);
    const seeded = JSON.parse(readFileSync(seedPath, "utf8")) as {
      provider: Record<string, unknown>;
      [k: string]: unknown;
    };
    seeded.theme = "dark";
    seeded.model = "opper/claude-opus-4-7";
    writeFileSync(seedPath, JSON.stringify(seeded, null, 2) + "\n", "utf8");

    spawnSyncMock.mockImplementation(() => {
      const cur = JSON.parse(readFileSync(seedPath, "utf8")) as {
        provider: Record<string, unknown>;
        theme: string;
        model: string;
        mcpServers?: Record<string, unknown>;
        [k: string]: unknown;
      };
      cur.theme = "light";
      cur.model = "opper/claude-haiku-4-5";
      cur.mcpServers = { fs: { command: "mcp-fs" } };
      writeFileSync(seedPath, JSON.stringify(cur, null, 2) + "\n", "utf8");
      return { status: 0 };
    });

    await opencode.spawn!([], ROUTING);

    const after = JSON.parse(readFileSync(seedPath, "utf8")) as {
      provider: { opper: { options: { baseURL: string } } };
      theme: string;
      model: string;
      mcpServers?: Record<string, unknown>;
    };
    // Non-Opper-owned siblings survive.
    expect(after.theme).toBe("light");
    expect(after.mcpServers).toEqual({ fs: { command: "mcp-fs" } });
    // Opper-owned keys revert to pre-launch state.
    expect(after.model).toBe("opper/claude-opus-4-7");
    expect(after.provider.opper.options.baseURL).toBe(
      "https://api.opper.ai/v3/compat",
    );
  });

  it("user scope: a fresh first launch leaves no opencode.json behind (covers $schema, provider.opper, model)", async () => {
    // The template (data/opencode.json) writes THREE Opper-owned
    // top-level keys: $schema, provider.opper, model. Narrow restore
    // must cover all three — otherwise a fresh first launch leaves
    // orphan state behind and the launch isn't truly ephemeral.
    const cfg = opencodeConfigPath(sandbox);
    expect(existsSync(cfg)).toBe(false);
    configureOpenCodeMock.mockImplementation(async () => {
      mkdirSync(join(sandbox, ".config", "opencode"), { recursive: true });
      writeFileSync(
        cfg,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider: {
            opper: {
              npm: "@ai-sdk/openai-compatible",
              options: {
                baseURL: "https://api.opper.ai/v3/compat",
                apiKey: "{env:OPPER_API_KEY}",
              },
            },
          },
          model: "opper/claude-opus-4-7",
        }, null, 2) + "\n",
        "utf8",
      );
      return { path: cfg, wrote: true };
    });
    spawnSyncMock.mockReturnValue({ status: 0 });

    await opencode.spawn!([], ROUTING);

    expect(existsSync(cfg)).toBe(false);
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
    expect(configureOpenCodeMock).toHaveBeenCalledWith({ location: "local", overwrite: true, models: {} });
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
      // Simulate `configureOpenCode({overwrite: true})` — it really
      // does replace provider.opper with template values (compat URL),
      // wiping the user's custom baseURL. The fix is to capture
      // `restoreUrl` before this call.
      configureOpenCodeMock.mockImplementation(async () => {
        const cur = JSON.parse(readFileSync(projectCfg, "utf8")) as {
          provider?: { opper?: { options?: { baseURL?: string } } };
        };
        cur.provider = cur.provider ?? {};
        cur.provider.opper = {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "https://api.opper.ai/v3/compat",
            apiKey: "{env:OPPER_API_KEY}",
          },
        } as never;
        writeFileSync(projectCfg, JSON.stringify(cur, null, 2), "utf8");
        return { path: projectCfg, wrote: true };
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

});
