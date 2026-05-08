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

const spawnSyncMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return { ...actual, spawnSync: spawnSyncMock };
});

const { codex } = await import("../../src/agents/codex.js");

const SESSION_URL =
  "https://api.opper.ai/v3/session/sess_aa11bb22-cccc-4ddd-8eee-ffff00001111/customer:acme";

describe("codex adapter", () => {
  let sandbox: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    whichMock.mockReset();
    runMock.mockReset();
    spawnSyncMock.mockReset();
    sandbox = mkdtempSync(join(tmpdir(), "opper-codex-"));
    prevHome = process.env.HOME;
    process.env.HOME = sandbox;
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });

  it("metadata is correct", () => {
    expect(codex.name).toBe("codex");
    expect(codex.displayName).toBe("Codex");
    expect(typeof codex.spawn).toBe("function");
    expect(typeof codex.install).toBe("function");
  });

  it("detect returns installed=false when codex not on PATH", async () => {
    whichMock.mockResolvedValue(null);
    const result = await codex.detect();
    expect(result.installed).toBe(false);
  });

  it("detect returns installed=true and the config path when found", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/codex");
    const result = await codex.detect();
    expect(result.installed).toBe(true);
    expect(result.configPath).toMatch(/\.codex\/config\.toml$/);
  });

  it("isConfigured is false when ~/.codex/config.toml does not exist", async () => {
    expect(await codex.isConfigured()).toBe(false);
  });

  it("configure writes the opper block with sentinels and the v3/compat base url", async () => {
    await codex.configure({});
    const cfgPath = join(sandbox, ".codex", "config.toml");
    expect(existsSync(cfgPath)).toBe(true);
    const text = readFileSync(cfgPath, "utf8");
    expect(text).toContain("# >>> opper-cli >>>");
    expect(text).toContain("# <<< opper-cli <<<");
    expect(text).toContain('base_url = "https://api.opper.ai/v3/compat"');
    expect(text).toContain('wire_api = "responses"');
    expect(text).toContain("[profiles.opper-opus]");
    expect(text).toContain("[profiles.opper-sonnet]");
    expect(await codex.isConfigured()).toBe(true);
  });

  it("configure writes one profile block per PICKER_MODELS entry", async () => {
    const { PICKER_MODELS } = await import("../../src/config/models.js");
    await codex.configure({});
    const text = readFileSync(join(sandbox, ".codex", "config.toml"), "utf8");
    for (const m of PICKER_MODELS) {
      // Profile header + the corresponding model id appear in the block.
      expect(text).toContain(`[profiles.opper-${m.codexProfile}]`);
      expect(text).toContain(`model = "${m.id}"`);
    }
  });

  it("configure preserves user content outside the sentinels", async () => {
    const cfgDir = join(sandbox, ".codex");
    const cfgPath = join(cfgDir, "config.toml");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      cfgPath,
      [
        "# user customisation",
        "[settings]",
        'theme = "dark"',
        "",
      ].join("\n"),
      "utf8",
    );
    await codex.configure({});
    const text = readFileSync(cfgPath, "utf8");
    expect(text).toContain("# user customisation");
    expect(text).toContain("[settings]");
    expect(text).toContain('theme = "dark"');
    expect(text).toContain("[model_providers.opper]");
  });

  it("configure is idempotent — re-running replaces the previous block", async () => {
    await codex.configure({});
    const first = readFileSync(join(sandbox, ".codex", "config.toml"), "utf8");
    await codex.configure({});
    const second = readFileSync(join(sandbox, ".codex", "config.toml"), "utf8");
    // Sentinels appear exactly once each.
    expect((second.match(/# >>> opper-cli >>>/g) ?? []).length).toBe(1);
    expect((second.match(/# <<< opper-cli <<</g) ?? []).length).toBe(1);
    expect(second).toBe(first);
  });

  it("unconfigure removes the opper block but keeps user content", async () => {
    const cfgDir = join(sandbox, ".codex");
    const cfgPath = join(cfgDir, "config.toml");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(cfgPath, '[settings]\ntheme = "dark"\n', "utf8");
    await codex.configure({});
    await codex.unconfigure();
    const text = readFileSync(cfgPath, "utf8");
    expect(text).not.toContain("# >>> opper-cli >>>");
    expect(text).not.toContain("[model_providers.opper]");
    expect(text).toContain("[settings]");
    expect(text).toContain('theme = "dark"');
  });

  it("install runs `npm i -g @openai/codex` and resolves on exit 0", async () => {
    whichMock.mockResolvedValue("/usr/bin/npm");
    runMock.mockReturnValue({ code: 0, stdout: "", stderr: "" });
    await expect(codex.install!()).resolves.toBeUndefined();
    const [cmd, args, options] = runMock.mock.calls[0]!;
    expect(cmd).toMatch(/^npm(\.cmd)?$/);
    expect(args).toEqual(["install", "-g", "@openai/codex"]);
    expect(options).toMatchObject({ inherit: true });
  });

  it("install throws AGENT_NOT_FOUND when npm exits non-zero", async () => {
    whichMock.mockResolvedValue("/usr/bin/npm");
    runMock.mockReturnValue({ code: 1, stdout: "", stderr: "boom" });
    await expect(codex.install!()).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  });

  it("spawn injects OPPER_API_KEY and prepends --profile opper-opus when no profile is set", async () => {
    // The session URL from routing.baseUrl is written into the config.toml
    // managed block during spawn — that's how Codex picks up the per-launch
    // session. Capture the file mid-run since we restore on exit.
    const cfgPath = join(sandbox, ".codex", "config.toml");
    let midRunCfg = "";
    spawnSyncMock.mockImplementation(() => {
      midRunCfg = readFileSync(cfgPath, "utf8");
      return { status: 0 };
    });
    const code = await codex.spawn!(["chat"], {
      baseUrl: SESSION_URL,
      apiKey: "op_live_run",
      model: "claude-opus-4-7",
      compatShape: "openai",
    });
    expect(code).toBe(0);

    const call = spawnSyncMock.mock.calls[0]!;
    expect(call[0]).toBe("codex");
    expect(call[1]).toEqual(["--profile", "opper-opus", "chat"]);
    const init = call[2] as { env: NodeJS.ProcessEnv };
    expect(init.env.OPPER_API_KEY).toBe("op_live_run");

    expect(midRunCfg).toContain(`base_url = "${SESSION_URL}"`);
    expect(midRunCfg).not.toContain('base_url = "https://api.opper.ai/v3/compat"');
  });

  it("spawn does not add --profile when the user already passed one", async () => {
    spawnSyncMock.mockReturnValue({ status: 0 });
    await codex.spawn!(["--profile", "opper-sonnet", "chat"], {
      baseUrl: SESSION_URL,
      apiKey: "k",
      model: "m",
      compatShape: "openai",
    });
    const call = spawnSyncMock.mock.calls[0]!;
    expect(call[1]).toEqual(["--profile", "opper-sonnet", "chat"]);
  });

  it("spawn propagates non-zero exit codes", async () => {
    spawnSyncMock.mockReturnValue({ status: 2 });
    const code = await codex.spawn!([], {
      baseUrl: SESSION_URL,
      apiKey: "k",
      model: "m",
      compatShape: "openai",
    });
    expect(code).toBe(2);
  });

  it("spawn restores the pre-launch config so direct `codex` runs don't inherit the session URL", async () => {
    // User has run `opper agents add codex` previously — config has the
    // default compat URL baked in. When `opper launch` runs we rewrite
    // base_url to the session URL during the run, but afterwards it must
    // be back to what the user had.
    await codex.configure({});
    const cfgPath = join(sandbox, ".codex", "config.toml");
    const before = readFileSync(cfgPath, "utf8");
    expect(before).toContain('base_url = "https://api.opper.ai/v3/compat"');

    spawnSyncMock.mockImplementation(() => {
      // Mid-run the session URL is active — that's how Codex picks it up.
      const mid = readFileSync(cfgPath, "utf8");
      expect(mid).toContain(`base_url = "${SESSION_URL}"`);
      return { status: 0 };
    });
    await codex.spawn!([], {
      baseUrl: SESSION_URL,
      apiKey: "k",
      model: "m",
      compatShape: "openai",
    });

    expect(readFileSync(cfgPath, "utf8")).toBe(before);
  });

  it("spawn deletes the config it created when none existed before", async () => {
    // User never configured codex through opper. `opper launch codex`
    // shouldn't leave a config file behind.
    const cfgPath = join(sandbox, ".codex", "config.toml");
    expect(existsSync(cfgPath)).toBe(false);

    spawnSyncMock.mockReturnValue({ status: 0 });
    await codex.spawn!([], {
      baseUrl: SESSION_URL,
      apiKey: "k",
      model: "m",
      compatShape: "openai",
    });

    expect(existsSync(cfgPath)).toBe(false);
  });

  it("spawn restores the pre-launch config even if the agent exits non-zero", async () => {
    await codex.configure({});
    const cfgPath = join(sandbox, ".codex", "config.toml");
    const before = readFileSync(cfgPath, "utf8");

    spawnSyncMock.mockReturnValue({ status: 17 });
    const code = await codex.spawn!([], {
      baseUrl: SESSION_URL,
      apiKey: "k",
      model: "m",
      compatShape: "openai",
    });
    expect(code).toBe(17);
    expect(readFileSync(cfgPath, "utf8")).toBe(before);
  });

  it("spawn restore preserves user edits outside the sentinel block made mid-spawn", async () => {
    // Anything outside the SENTINEL_OPEN/CLOSE markers is the user's
    // own config (theme, settings, etc.). The narrow restore must
    // not clobber edits made there during the session.
    const cfgDir = join(sandbox, ".codex");
    const cfgPath = join(cfgDir, "config.toml");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(cfgPath, "[settings]\ntheme = \"dark\"\n", "utf8");
    await codex.configure({});

    spawnSyncMock.mockImplementation(() => {
      // Simulate the user editing the [settings] block mid-session.
      const cur = readFileSync(cfgPath, "utf8");
      writeFileSync(cfgPath, cur.replace('theme = "dark"', 'theme = "light"'), "utf8");
      return { status: 0 };
    });

    await codex.spawn!([], {
      baseUrl: SESSION_URL,
      apiKey: "k",
      model: "m",
      compatShape: "openai",
    });

    const after = readFileSync(cfgPath, "utf8");
    expect(after).toContain('theme = "light"'); // sibling edit survived
    expect(after).toContain('base_url = "https://api.opper.ai/v3/compat"'); // our block reverted
    expect(after).not.toContain(SESSION_URL);
  });
});
