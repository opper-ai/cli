import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { readDesktopConfig } from "../../src/setup/codex-desktop-config.js";
import { setSlot, deleteSlot } from "../../src/auth/config.js";
import { OpperError } from "../../src/errors.js";
import { ensurePrivateStateDirectory, ensurePrivateStateFile } from "../../src/desktop/private-state.js";

const mocks = vi.hoisted(() => {
  const { existsSync } = require("node:fs") as typeof import("node:fs");
  return {
    realExists: existsSync,
    platform: vi.fn(() => "darwin"),
    homedir: vi.fn(() => "/nonexistent"),
    run: vi.fn(),
    fetchCatalog: vi.fn(),
    apps: new Set<string>(),
    runtimeLayout: "legacy",
  };
});

vi.mock("node:os", async () => ({
  ...await vi.importActual<typeof import("node:os")>("node:os"),
  platform: mocks.platform,
  homedir: mocks.homedir,
}));
vi.mock("node:fs", async () => ({
  ...await vi.importActual<typeof import("node:fs")>("node:fs"),
  existsSync: (path: string) => {
    const normalized = path.replaceAll("\\", "/");
    if ([...mocks.apps].some((app) => {
      const normalizedApp = app.replaceAll("\\", "/");
      if (normalized === `${normalizedApp}/Contents/Resources/codex`) return mocks.runtimeLayout === "legacy";
      if (normalized === `${normalizedApp}/Contents/Resources/codex-cli/bin/codex`) return mocks.runtimeLayout === "nested";
      return normalized === normalizedApp || normalized.startsWith(`${normalizedApp}/`);
    })) return true;
    if (normalized.startsWith("/Applications/")) return false;
    return mocks.realExists(path);
  },
}));
vi.mock("../../src/util/run.js", () => ({ run: mocks.run }));
vi.mock("../../src/setup/codex-models.js", async () => ({
  ...await vi.importActual<typeof import("../../src/setup/codex-models.js")>("../../src/setup/codex-models.js"),
  fetchCodexModelCatalog: mocks.fetchCatalog,
}));

const { codexDesktop } = await import("../../src/agents/codex-desktop.js");
const { toCodexModelCatalog } = await import("../../src/setup/codex-models.js");

const API_ROOT = "https://gateway.example/tenant";
const MODEL = "claude-sonnet-5";
const KEY = "fixture-prod-key-not-a-real-credential";
const ORIGINAL = '# personal defaults\nmodel = "gpt-5.5" # chosen model\nmodel_provider = "openai"\n\n[features]\nmulti_agent = true\n\n[projects."/personal/project"]\ntrust_level = "trusted"\n\n[mcp_servers.notes]\ncommand = "notes"\n';

let home: string;
let codexHome: string;
let opperHome: string;
let appRunning: boolean;
let bundleId: string;
let runtimeVersion: string;

function ok(stdout = "") { return { code: 0, stdout, stderr: "" }; }
function options(overrides = {}) {
  return { apiKey: KEY, keyName: "prod", baseUrl: API_ROOT, model: MODEL, ...overrides };
}
function routing(overrides = {}) {
  return {
    apiKey: KEY, keyName: "prod", apiBaseUrl: API_ROOT,
    baseUrl: `${API_ROOT}/v3/session/sess_fixture`, model: MODEL,
    compatShape: "responses" as const, ...overrides,
  };
}
function configText(): string { return readFileSync(join(codexHome, "config.toml"), "utf8"); }
function provider(): Record<string, any> {
  return (readDesktopConfig(configText()).model_providers as Record<string, any>)["opper-desktop"];
}
function configuredHelper() {
  const auth = provider().auth as { command: string; args: string[] };
  expect(isAbsolute(auth.command)).toBe(true);
  expect(realpathSync(auth.command)).toBe(realpathSync(process.execPath));
  expect(auth.args.some((arg) => arg === join(codexHome, "opper-desktop", "auth.mjs"))).toBe(true);
  const operatingSystemEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:SystemRoot|WINDIR|SystemDrive|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA)$/i.test(key)));
  return () => spawnSync(auth.command, auth.args, {
    encoding: "utf8", timeout: process.platform === "win32" ? 20_000 : 5_000,
    // Finder has neither the launch shell's key nor its Opper home override.
    env: { ...operatingSystemEnv, PATH: process.env.PATH ?? "", HOME: join(home, "finder-home") },
  });
}
function successfulHelperOutput(helper: ReturnType<typeof configuredHelper>): string {
  const result = helper();
  // Never include stdout in diagnostics: it contains the authentication token.
  const diagnostics = JSON.stringify({status: result.status, signal: result.signal, errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
    stderr: result.stderr.replaceAll(KEY, "[redacted]").replace(/[a-f0-9]{64}/g, "[redacted]")});
  expect(result.status, diagnostics).toBe(0);
  return result.stdout;
}
function allText(directory: string): string {
  return readdirSync(directory, { withFileTypes: true }).map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? allText(path) : readFileSync(path, "utf8");
  }).join("\n");
}
async function desktopProxy() {
  const stateDir = join(home, "private bridge state");
  await ensurePrivateStateDirectory(stateDir, true);
  const proxy = {baseUrl: "http://127.0.0.1:19437", token: "a".repeat(64), stateDir};
  const manifest = {version: 1, url: proxy.baseUrl, token: proxy.token, pid: process.pid};
  const path = join(stateDir, "bridge.json");
  await ensurePrivateStateFile(path, true);
  const write = (updates = {}) => writeFileSync(path, JSON.stringify({...manifest, ...updates}), {mode: 0o600});
  write();
  return {proxy, path, write};
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "opper codex desktop test "));
  codexHome = join(home, "Codex Home");
  opperHome = join(home, "Opper Home");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "config.toml"), ORIGINAL);
  vi.stubEnv("CODEX_HOME", codexHome);
  vi.stubEnv("OPPER_HOME", opperHome);
  vi.stubEnv("OPPER_API_KEY", undefined);
  vi.stubEnv("OPPER_BASE_URL", undefined);
  vi.stubEnv("CODEX_ELECTRON_USER_DATA_PATH", undefined);
  mocks.homedir.mockReturnValue(home);
  mocks.platform.mockReturnValue("darwin");
  mocks.apps.clear();
  mocks.apps.add("/Applications/ChatGPT.app");
  mocks.runtimeLayout = "legacy";
  appRunning = false;
  bundleId = "com.openai.codex";
  runtimeVersion = "0.153.4";
  mocks.run.mockReset();
  mocks.run.mockImplementation((command: string, args: string[]) => {
    if (command.endsWith("plutil")) return ok(args.includes("CFBundleExecutable") ? "ChatGPT" : bundleId);
    if (/[/\\]codex$/.test(command) && args.includes("--version")) return ok(`codex-cli ${runtimeVersion}\n`);
    if (command.endsWith("pgrep")) return appRunning ? ok("98765\n") : { code: 1, stdout: "", stderr: "" };
    return ok();
  });
  mocks.fetchCatalog.mockReset();
  mocks.fetchCatalog.mockImplementation(async (_context, selected) => toCodexModelCatalog([
    { id: MODEL, opper: { kind: "pool", type: "llm", capabilities: ["tools", "vision"] } },
    { id: "claude-opus-5", opper: { kind: "pool", type: "llm", capabilities: ["tools"] } },
  ], selected));
  await setSlot("default", { apiKey: "fixture-other-key", baseUrl: "https://api.opper.ai" });
  await setSlot("prod", { apiKey: KEY, baseUrl: API_ROOT });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("Codex desktop detection", () => {
  it("rejects an environment key instead of borrowing a stored credential for Finder launches", async () => {
    vi.stubEnv("OPPER_API_KEY", "independent-env-key");
    await expect(codexDesktop.configure(options())).rejects.toMatchObject({ code: "AUTH_REQUIRED", message: expect.stringContaining("stored Opper credential") });
    expect(mocks.fetchCatalog).not.toHaveBeenCalled();
  });

  it("targets discovery and persistent requests explicitly and keeps the target in relaunch guidance", async () => {
    const projectUuid = "11111111-1111-4111-8111-111111111111";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await codexDesktop.configure(options({ projectUuid }));
      expect(mocks.fetchCatalog).toHaveBeenCalledWith({ apiKey: KEY, baseUrl: API_ROOT, projectUuid }, MODEL);
      expect(provider().http_headers).toEqual({ "X-Opper-Project": projectUuid });
      expect(log.mock.calls.flat().join(" ")).toContain(`'--project-uuid' '${projectUuid}'`);
    } finally { log.mockRestore(); }
  });

  it("refreshes a renewed key in the same organization but rejects expiry and organization changes", async () => {
    await setSlot("prod", { apiKey: KEY, baseUrl: API_ROOT, orgId: 42 });
    await codexDesktop.configure(options());
    const helper = configuredHelper();
    await setSlot("prod", { apiKey: "renewed", baseUrl: API_ROOT, orgId: 42 });
    expect(helper().stdout).toBe("renewed");
    await setSlot("prod", { apiKey: "expired", baseUrl: API_ROOT, orgId: 42, expiresAt: "2020-01-01" });
    expect(helper().status).toBe(1);
    await setSlot("prod", { apiKey: "other-org", baseUrl: API_ROOT, orgId: 43 });
    expect(helper().status).toBe(1);
  });
  it("accepts the combined ChatGPT app with the Codex bundle and supported runtime", async () => {
    expect(await codexDesktop.detect()).toMatchObject({ installed: true });
    expect(mocks.run.mock.calls.some(([command]) => command === join("/Applications/ChatGPT.app", "Contents", "Resources", "codex"))).toBe(true);
  });

  it("detects and launches current apps with the nested Codex CLI runtime", async () => {
    mocks.runtimeLayout = "nested";
    runtimeVersion = "0.162.0-alpha.17.2";
    const runtime = join("/Applications/ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex");

    expect(await codexDesktop.detect()).toMatchObject({ installed: true, version: "0.162.0" });
    await expect(codexDesktop.spawn!([], routing())).resolves.toBe(0);
    expect(mocks.run).toHaveBeenCalledWith(runtime, ["--version"]);
    expect(mocks.run.mock.calls.some(([command]) => command === "open")).toBe(true);
  });

  it("also finds the separate Codex app", async () => {
    mocks.apps.clear();
    mocks.apps.add("/Applications/Codex.app");
    expect(await codexDesktop.detect()).toMatchObject({ installed: true });
  });

  it.each([
    ["system Codex", "/Applications/Codex.app", "0.153.4"],
    ["user-local ChatGPT", "ChatGPT.app", "0.154.0"],
    ["user-local Codex", "Codex.app", "1.0.0"],
  ])("selects compatible %s when system ChatGPT is too old", async (_name, appPath, version) => {
    const app = isAbsolute(appPath) ? appPath : join(home, "Applications", appPath);
    const runtime = join(app, "Contents", "Resources", "codex");
    mocks.apps.add(app);
    runtimeVersion = "0.153.3";
    const run = mocks.run.getMockImplementation()!;
    mocks.run.mockImplementation((command: string, args: string[]) => command === runtime && args.includes("--version")
      ? ok(`codex-cli ${version}\n`)
      : run(command, args));

    expect(await codexDesktop.detect()).toMatchObject({ installed: true, version });
    await expect(codexDesktop.spawn!([], routing())).resolves.toBe(0);
    expect(mocks.run.mock.calls.find(([command]) => command === "open")?.[1]).toContain(app);
  });

  it("keeps the first compatible app instead of selecting a later newer copy", async () => {
    mocks.apps.add("/Applications/Codex.app");
    const run = mocks.run.getMockImplementation()!;
    const runtime = join("/Applications/Codex.app", "Contents", "Resources", "codex");
    mocks.run.mockImplementation((command: string, args: string[]) => command === runtime
      ? ok("codex-cli 0.154.0\n")
      : run(command, args));

    expect(await codexDesktop.detect()).toMatchObject({ installed: true, version: "0.153.4" });
    expect(mocks.run.mock.calls.some(([command]) => command === runtime)).toBe(false);
  });

  it("retains update guidance when every valid installed app is too old", async () => {
    mocks.apps.add("/Applications/Codex.app");
    runtimeVersion = "0.153.3";

    expect(await codexDesktop.detect()).toMatchObject({ installed: true, version: "0.153.3" });
    await expect(codexDesktop.configure(options())).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
      message: "The app bundles Codex 0.153.3; Opper desktop requires 0.153.4 or later.",
    });
    expect(configText()).toBe(ORIGINAL);
    expect(mocks.fetchCatalog).not.toHaveBeenCalled();
    expect(mocks.run.mock.calls.some(([command]) => command === "open")).toBe(false);
  });

  it("does not mistake ChatGPT Classic for the Codex app", async () => {
    bundleId = "com.openai.chat";
    expect(await codexDesktop.detect()).toMatchObject({ installed: false });
  });

  it("rejects unsupported platforms and guards configuration on old runtimes", async () => {
    mocks.platform.mockReturnValue("linux");
    expect(await codexDesktop.detect()).toMatchObject({ installed: false });
    mocks.platform.mockReturnValue("darwin");
    runtimeVersion = "0.153.3";
    expect(await codexDesktop.detect()).toMatchObject({ installed: true, version: "0.153.3" });
    await expect(codexDesktop.configure(options())).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
    expect(configText()).toBe(ORIGINAL);
  });
});

describe("Codex desktop configuration and credentials", () => {
  it("uses the selected slot and host for discovery and writes persistent keyless configuration", async () => {
    await codexDesktop.configure(options());
    expect(mocks.fetchCatalog).toHaveBeenCalledWith({ apiKey: KEY, baseUrl: API_ROOT }, MODEL);
    const config = readDesktopConfig(configText());
    expect(config).toMatchObject({ model_provider: "opper-desktop", model: MODEL });
    expect(config.model_catalog_json).toBe(join(codexHome, "opper-desktop", "catalog.json"));
    expect(provider()).toMatchObject({ base_url: `${API_ROOT}/v3/compat`, wire_api: "responses" });
    expect(configText()).toContain('# personal defaults\nmodel = "claude-sonnet-5" # chosen model');
    expect(configText()).toContain('[features]\nmulti_agent = true');
    expect(allText(codexHome)).not.toContain(KEY);
    expect(await codexDesktop.isConfigured()).toBe(true);
    const token = configuredHelper()();
    expect(token.status).toBe(0);
    expect(token.stdout.trim()).toBe(KEY);
    expect(token.stderr).toBe("");
  });

  it("picks up key rotation, then fails closed when the stored slot is revoked", async () => {
    await codexDesktop.configure(options());
    const helper = configuredHelper();
    await setSlot("prod", { apiKey: "fixture-rotated-key", baseUrl: API_ROOT });
    expect(helper().stdout.trim()).toBe("fixture-rotated-key");
    await deleteSlot("prod");
    const revoked = helper();
    expect(revoked.status).not.toBe(0);
    expect(revoked.stdout).toBe("");
    expect(revoked.stderr).not.toContain(KEY);
  });

  it("does not send a rotated slot's credential to a different host", async () => {
    await codexDesktop.configure(options());
    const helper = configuredHelper();
    await setSlot("prod", { apiKey: "fixture-other-host-key", baseUrl: "https://different.example" });
    const changed = helper();
    expect(changed.status).not.toBe(0);
    expect(changed.stdout).toBe("");
    expect(changed.stderr).not.toContain("fixture-other-host-key");
  });

  it("fails before writing anything when discovery rejects authentication", async () => {
    mocks.fetchCatalog.mockRejectedValue(new OpperError("AUTH_EXPIRED", "rejected"));
    await expect(codexDesktop.configure(options())).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(configText()).toBe(ORIGINAL);
    expect(mocks.realExists(join(codexHome, "opper-desktop"))).toBe(false);
  });

  it.each(["config.toml", "opper-desktop/auth.mjs", "opper-desktop/catalog.json", "opper-desktop/state.json", "opper-desktop"])(
    "preserves linked %s and its target instead of configuring through it",
    async (relativePath) => {
      const linked = join(codexHome, relativePath);
      const target = join(home, "user-owned-target");
      const isDirectory = relativePath === "opper-desktop";
      if (isDirectory) {
        mkdirSync(target);
        writeFileSync(join(target, "note.txt"), "Preserve this directory.");
      } else writeFileSync(target, relativePath === "config.toml" ? ORIGINAL : "Preserve this file.");
      mkdirSync(dirname(linked), { recursive: true });
      if (relativePath === "config.toml") rmSync(linked);
      symlinkSync(target, linked, isDirectory ? "dir" : "file");
      const before = isDirectory ? allText(target) : readFileSync(target, "utf8");

      await expect(codexDesktop.configure(options())).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
      expect(lstatSync(linked).isSymbolicLink()).toBe(true);
      expect(isDirectory ? allText(target) : readFileSync(target, "utf8")).toBe(before);
      expect(mocks.fetchCatalog).not.toHaveBeenCalled();
      if (relativePath !== "config.toml") expect(configText()).toBe(ORIGINAL);
    },
  );

  it("refuses a directory where config.toml should be without altering it", async () => {
    rmSync(join(codexHome, "config.toml"));
    mkdirSync(join(codexHome, "config.toml"));
    writeFileSync(join(codexHome, "config.toml", "note.txt"), "User file.");
    await expect(codexDesktop.configure(options())).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    expect(readFileSync(join(codexHome, "config.toml", "note.txt"), "utf8")).toBe("User file.");
    expect(mocks.fetchCatalog).not.toHaveBeenCalled();
  });

  it("requires a saved slot instead of persisting an environment-only key", async () => {
    await deleteSlot("prod");
    await expect(codexDesktop.configure(options())).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(configText()).toBe(ORIGINAL);
    expect(mocks.fetchCatalog).not.toHaveBeenCalled();
  });

  it("rejects a resolved key that differs from the slot the desktop helper will use", async () => {
    await expect(codexDesktop.configure(options({ apiKey: "fixture-different-key" })))
      .rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    expect(configText()).toBe(ORIGINAL);
    expect(mocks.fetchCatalog).not.toHaveBeenCalled();
  });

  it("uses an explicit API root consistently for discovery and the provider", async () => {
    await codexDesktop.configure(options({ baseUrl: "https://override.example/api/" }));
    expect(mocks.fetchCatalog).toHaveBeenCalledWith({ apiKey: KEY, baseUrl: "https://override.example/api" }, MODEL);
    expect(provider().base_url).toBe("https://override.example/api/v3/compat");
    expect(configuredHelper()().stdout.trim()).toBe(KEY);
  });

  it("reconfiguration changes the selected model and removal restores the original config", async () => {
    await codexDesktop.configure(options());
    await codexDesktop.configure(options({ model: "claude-opus-5" }));
    expect(readDesktopConfig(configText()).model).toBe("claude-opus-5");
    await codexDesktop.unconfigure();
    expect(configText()).toBe(ORIGINAL);
    expect(await codexDesktop.isConfigured()).toBe(false);
    expect(mocks.realExists(join(codexHome, "opper-desktop", "auth.mjs"))).toBe(false);
  });

  it("preserves new user settings and intentional model changes on removal", async () => {
    await codexDesktop.configure(options());
    writeFileSync(join(codexHome, "config.toml"), configText()
      .replace('model = "claude-sonnet-5"', 'model = "personal-choice"') + '\n[desktop]\ntheme = "dark"\n');
    await codexDesktop.unconfigure();
    expect(readDesktopConfig(configText())).toMatchObject({ model: "personal-choice", model_provider: "openai", desktop: { theme: "dark" } });
    expect(configText()).toContain("# chosen model");
    expect(configText()).toContain('[mcp_servers.notes]\ncommand = "notes"');
    expect(configText()).not.toContain("opper-desktop");
  });

  it("preserves the configuration and recovery files when an independently changed provider blocks removal", async () => {
    await codexDesktop.configure(options());
    writeFileSync(join(codexHome, "config.toml"), configText().replace('name = "Opper"', 'name = "My edited provider"'));
    const before = allText(codexHome);
    await expect(codexDesktop.unconfigure()).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    expect(allText(codexHome)).toBe(before);
    for (const file of ["auth.mjs", "catalog.json", "state.json"]) {
      expect(mocks.realExists(join(codexHome, "opper-desktop", file))).toBe(true);
    }
  });

  it("keeps user files added to the integration directory during removal", async () => {
    await codexDesktop.configure(options());
    const note = join(codexHome, "opper-desktop", "my-note.txt");
    writeFileSync(note, "Keep this user file.");
    await codexDesktop.unconfigure();
    expect(configText()).toBe(ORIGINAL);
    expect(readFileSync(note, "utf8")).toBe("Keep this user file.");
  });

  it("preserves recovery files and a linked config when removal is refused", async () => {
    await codexDesktop.configure(options());
    const applied = configText();
    const target = join(home, "user-owned-config.toml");
    writeFileSync(target, applied);
    rmSync(join(codexHome, "config.toml"));
    symlinkSync(target, join(codexHome, "config.toml"));
    const recovery = allText(join(codexHome, "opper-desktop"));

    await expect(codexDesktop.unconfigure()).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    expect(lstatSync(join(codexHome, "config.toml")).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(applied);
    expect(allText(join(codexHome, "opper-desktop"))).toBe(recovery);
  });
});

describe("Codex desktop launching", () => {
  it("uses a persistent gateway endpoint and opens the detected application", async () => {
    await expect(codexDesktop.spawn!([], routing())).resolves.toBe(0);
    expect(provider().base_url).toBe(`${API_ROOT}/v3/compat`);
    expect(allText(codexHome)).not.toContain("sess_fixture");
    const open = mocks.run.mock.calls.find(([command]) => command === "open");
    expect(open?.[1]).toContain("/Applications/ChatGPT.app");
  });

  it("does not silently quit or restart an already-running application", async () => {
    appRunning = true;
    await expect(codexDesktop.spawn!([], routing())).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    expect(mocks.run.mock.calls.filter(([command]) => ["open", "osascript", "kill", "pkill"].includes(command))).toEqual([]);
  });

  it("uses a POSIX process expression that recognizes the app with command arguments", async () => {
    await codexDesktop.spawn!([], routing());
    const processArgs = mocks.run.mock.calls.find(([command]) => command === "pgrep")?.[1] as string[];
    expect(processArgs?.[0]).toBe("-f");
    expect(processArgs[1]).toMatch(/^\^/);
    expect(processArgs[1]).toContain("([[:space:]]|$)");
    // Native Windows has no pgrep; MSYS grep rewrites path-like expressions.
    // Keep the mocked invocation checks above, and run POSIX grep on POSIX.
    if (process.platform === "win32") return;
    const matched = spawnSync("grep", ["-E", processArgs[1]!], {
      input: `${join("/Applications/ChatGPT.app", "Contents", "MacOS", "ChatGPT")} --some-argument\n`,
      encoding: "utf8", timeout: 5_000,
    });
    expect(matched.status).toBe(0);
  });

  it("does not open another instance when process inspection fails", async () => {
    const run = mocks.run.getMockImplementation()!;
    mocks.run.mockImplementation((command: string, args: string[]) => command === "pgrep"
      ? { code: 2, stdout: "", stderr: "process inspection failed" }
      : run(command, args));
    await expect(codexDesktop.spawn!([], routing())).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    expect(await codexDesktop.isConfigured()).toBe(true);
    expect(mocks.run.mock.calls.filter(([command]) => ["open", "osascript", "kill", "pkill"].includes(command))).toEqual([]);
  });

  it("rejects CLI passthrough arguments before writing configuration", async () => {
    await expect(codexDesktop.spawn!(["--profile", "other"], routing())).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(configText()).toBe(ORIGINAL);
    expect(mocks.fetchCatalog).not.toHaveBeenCalled();
  });
});

describe("Codex desktop opt-in local proxy", {timeout: 60_000}, () => {
  it("discovers models with the real credential while persisting only local routing and a token reader", async () => {
    const {proxy, write} = await desktopProxy();
    const projectUuid = "11111111-1111-4111-8111-111111111111";
    await codexDesktop.spawn!([], routing({desktopProxy: proxy, projectUuid}));
    expect(mocks.fetchCatalog).toHaveBeenCalledWith({apiKey: KEY, baseUrl: API_ROOT, projectUuid}, MODEL);
    expect(provider()).toMatchObject({base_url: `${proxy.baseUrl}/v3/compat`, wire_api: "responses", supports_websockets: false});
    expect(provider().http_headers).toBeUndefined();
    expect(allText(codexHome)).not.toContain(KEY);
    expect(allText(codexHome)).not.toContain(proxy.token);
    const helper = configuredHelper();
    expect(successfulHelperOutput(helper)).toBe(proxy.token);
    const renewed = "b".repeat(64);
    write({token: renewed});
    expect(successfulHelperOutput(helper)).toBe(renewed);
  });

  it("supports direct to proxy to direct transitions and removal restores personal settings", async () => {
    const {proxy} = await desktopProxy();
    await codexDesktop.configure(options());
    expect(successfulHelperOutput(configuredHelper())).toBe(KEY);
    await codexDesktop.configure(options({desktopProxy: proxy}));
    expect(provider().base_url).toBe(`${proxy.baseUrl}/v3/compat`);
    expect(successfulHelperOutput(configuredHelper())).toBe(proxy.token);
    await codexDesktop.configure(options());
    expect(provider().base_url).toBe(`${API_ROOT}/v3/compat`);
    expect(provider().supports_websockets).toBeUndefined();
    expect(configuredHelper()().stdout).toBe(KEY);
    await codexDesktop.unconfigure();
    expect(configText()).toBe(ORIGINAL);
    expect(mocks.realExists(join(codexHome, "opper-desktop"))).toBe(false);
  });

  it("removes a proxy integration without changing saved bridge state or personal defaults", async () => {
    const {proxy, path} = await desktopProxy();
    const savedRuntime = readFileSync(path, "utf8");
    await codexDesktop.configure(options({desktopProxy: proxy}));
    await codexDesktop.unconfigure();
    expect(configText()).toBe(ORIGINAL);
    expect(readFileSync(path, "utf8")).toBe(savedRuntime);
    expect(mocks.realExists(join(codexHome, "opper-desktop"))).toBe(false);
  });

  it.each([
    {url: "http://127.0.0.1:19438"},
    {url: "https://attacker.example", token: "private-token-never-print"},
    {token: "private-token-never-print"},
    {pid: 2147483647},
    {version: 2},
  ])("refuses invalid or stale bridge runtime state %j without exposing credentials", async (updates) => {
    const {proxy, write} = await desktopProxy();
    await codexDesktop.configure(options({desktopProxy: proxy}));
    const helper = configuredHelper();
    write(updates);
    const result = helper();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(KEY);
    expect(result.stderr).not.toContain("private-token-never-print");
  });

  it("refuses public or symlinked runtime files and missing bridge state", async () => {
    const {proxy, path} = await desktopProxy();
    await codexDesktop.configure(options({desktopProxy: proxy}));
    const helper = configuredHelper();
    if (process.platform === "win32") {
      const icacls = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
      const acl = (target: string, args: string[]) => expect(spawnSync(icacls, [target, ...args], {encoding: "utf8", timeout: 10_000}).status).toBe(0);
      acl(path, ["/grant", "*S-1-1-0:(R)"]);
      expect(helper().status).toBe(1);
      acl(path, ["/remove:g", "*S-1-1-0"]);
      acl(proxy.stateDir, ["/grant", "*S-1-1-0:(OI)(CI)(RX)"]);
      expect(helper().status).toBe(1);
      acl(proxy.stateDir, ["/remove:g", "*S-1-1-0"]);
    } else {
      chmodSync(path, 0o644);
      expect(helper().status).toBe(1);
      chmodSync(path, 0o600);
      chmodSync(proxy.stateDir, 0o755);
      expect(helper().status).toBe(1);
      chmodSync(proxy.stateDir, 0o700);
    }
    const target = join(home, "linked-runtime.json");
    writeFileSync(target, readFileSync(path), {mode: 0o600});
    rmSync(path); symlinkSync(target, path);
    expect(helper().status).toBe(1);
    rmSync(path);
    expect(helper().status).toBe(1);
  });

  it("preserves proxy selection in a custom-home restart hint", async () => {
    const {proxy} = await desktopProxy();
    appRunning = true;
    await expect(codexDesktop.spawn!([], routing({desktopProxy: proxy}))).rejects.toMatchObject({
      code: "AGENT_CONFIG_CONFLICT",
      hint: expect.stringContaining(`'--proxy' '--state-dir' '${proxy.stateDir}'`),
    });
  });

  it.each(["https://api.opper.ai", "http://localhost:19437", "http://127.0.0.1:19437/path", "http://user:password@127.0.0.1:19437"])('rejects a non-loopback-root proxy URL "%s" before changing settings', async (baseUrl) => {
    const {proxy} = await desktopProxy();
    await expect(codexDesktop.configure(options({desktopProxy: {...proxy, baseUrl}}))).rejects.toMatchObject({code: "INVALID_ARGUMENT"});
    expect(configText()).toBe(ORIGINAL);
  });
});

describe("Codex desktop custom-home guidance", () => {
  it("makes custom-home configure explicit without changing the default home", async () => {
    const defaultHome = join(home, ".codex");
    mkdirSync(defaultHome);
    writeFileSync(join(defaultHome, "config.toml"), "# untouched default\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await codexDesktop.configure(options());
      const text = log.mock.calls.flat().join("\n");
      expect(text).toContain(codexHome);
      expect(text).toContain("Finder");
      expect(text).toContain("same Codex home");
      expect(text).toContain("opper launch codex-desktop");
      expect(readFileSync(join(defaultHome, "config.toml"), "utf8")).toBe("# untouched default\n");
      expect(await codexDesktop.isConfigured()).toBe(true);
    } finally { log.mockRestore(); }
  });

  it("does not give custom-home guidance for the normal home", async () => {
    vi.stubEnv("CODEX_HOME", join(home, ".codex"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await codexDesktop.configure(options());
      expect(log.mock.calls.flat().join("\n")).not.toContain("same Codex home");
    } finally { log.mockRestore(); }
  });

  it("directs a running custom-home app back through the same launcher environment", async () => {
    appRunning = true;
    await expect(codexDesktop.spawn!([], routing())).rejects.toMatchObject({
      code: "AGENT_CONFIG_CONFLICT", hint: expect.stringContaining("same Codex home"),
    });
    expect(mocks.run.mock.calls.some(([command]) => command === "open")).toBe(false);
  });

  it("passes the custom home explicitly when opening the app", async () => {
    await codexDesktop.spawn!([], routing());
    const args = mocks.run.mock.calls.find(([command]) => command === "open")?.[1];
    expect(args).toContain(`CODEX_HOME=${codexHome}`);
  });
});

describe("explicit Codex home", () => {
  it("configures and removes only the explicit directory despite CODEX_HOME", async () => {
    const selected = join(home, "custom home's settings");
    mkdirSync(selected);
    writeFileSync(join(selected, "config.toml"), ORIGINAL);
    await codexDesktop.configure(options({ codexHome: selected }));
    expect(readDesktopConfig(readFileSync(join(selected, "config.toml"), "utf8")).model_provider).toBe("opper-desktop");
    expect(configText()).toBe(ORIGINAL);
    expect(process.env.CODEX_HOME).toBe(codexHome);
    await codexDesktop.unconfigure({ codexHome: selected });
    expect(readFileSync(join(selected, "config.toml"), "utf8")).toBe(ORIGINAL);
    expect(mocks.realExists(join(selected, "opper-desktop"))).toBe(false);
    expect(configText()).toBe(ORIGINAL);
  });

  it("launches with the explicit home and leaves the environment home untouched", async () => {
    const selected = join(home, "explicit launch");
    await codexDesktop.spawn!([], routing(), { codexHome: selected });
    expect(mocks.run.mock.calls.find(([command]) => command === "open")?.[1]).toContain(`CODEX_HOME=${selected}`);
    expect(configText()).toBe(ORIGINAL);
    expect(process.env.CODEX_HOME).toBe(codexHome);
  });

  it.skipIf(process.platform === "win32")("prints a POSIX shell-safe retry command for an explicit home", async () => {
    const selected = join(home, "custom home's settings");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await codexDesktop.configure(options({ codexHome: selected }));
      const command = log.mock.calls.flat().join("\n").split("\n")[1]!;
      const bin = join(home, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "opper"), '#!/bin/sh\nprintf "%s\\n" "$OPPER_HOME" "$@"\n', { mode: 0o700 });
      const executed = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", env: { ...process.env, OPPER_HOME: "/wrong-store", PATH: `${bin}:/usr/bin:/bin` } });
      expect(executed.status).toBe(0);
      expect(executed.stdout.trim().split("\n")).toEqual([opperHome, "--key", "prod", "launch", "codex-desktop", "--model", MODEL, "--codex-home", selected]);
    } finally { log.mockRestore(); }
  });

  it("rejects an empty explicit home before changing configuration", async () => {
    await expect(codexDesktop.configure(options({ codexHome: " " }))).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(configText()).toBe(ORIGINAL);
    expect(mocks.fetchCatalog).not.toHaveBeenCalled();
  });
});

describe("Codex desktop on Windows", {timeout: 60_000}, () => {
  let appRoot: string;
  let executable: string;
  let runtime: string;
  let running: boolean;
  beforeEach(() => {
    mocks.platform.mockReturnValue("win32");
    appRoot = join(home, "WindowsApps", "OpenAI.Codex_fixture", "app");
    executable = join(appRoot, "Codex.exe");
    runtime = join(appRoot, "resources", "codex-cli", "vendor", "x86_64-pc-windows-msvc", "codex", "codex.exe");
    mkdirSync(dirname(runtime), {recursive: true});
    writeFileSync(executable, "fixture"); writeFileSync(runtime, "fixture");
    running = false;
    mocks.run.mockImplementation((command: string, args: string[]) => {
      const script = args.at(-1) ?? "";
      if (command === "powershell.exe" && script.includes("Get-AppxPackage")) return ok(JSON.stringify([{installLocation: dirname(appRoot), executable: "app/Codex.exe", aumid: "OpenAI.Codex_fixture!App"}]));
      if (command === runtime && args.includes("--version")) return ok("codex-cli 0.162.0\n");
      if (command === "powershell.exe" && script.includes("Get-Process")) return ok(running ? "123\n" : "");
      return ok();
    });
  });

  it("discovers the registered MSIX app and its supported bundled runtime", async () => {
    expect(await codexDesktop.detect()).toMatchObject({installed: true, version: "0.162.0"});
    expect(mocks.run).toHaveBeenCalledWith(runtime, ["--version"], {timeout: 5_000});
    expect(mocks.run.mock.calls.some(([command]) => /plutil|pgrep/.test(command))).toBe(false);
  });
  it("configures the proxy and launches Windows with the selected Codex home", async () => {
    const {proxy} = await desktopProxy();
    await expect(codexDesktop.spawn!([], routing({desktopProxy: proxy}))).resolves.toBe(0);
    expect(provider()).toMatchObject({base_url: `${proxy.baseUrl}/v3/compat`, supports_websockets: false});
    expect(allText(codexHome)).not.toContain(KEY);
    const launch = mocks.run.mock.calls.find(([command, args]) => command === "powershell.exe" && args.at(-1)?.includes("Start-Process"))?.[1].at(-1);
    expect(launch).toContain(executable);
    expect(launch).toContain(codexHome);
    expect(launch).toContain("CODEX_HOME");
    for (const [command, , options] of mocks.run.mock.calls) {
      if (command === "powershell.exe") expect(options).toMatchObject({timeout: 5_000});
    }
    expect(mocks.run.mock.calls.some(([command]) => command === "open")).toBe(false);
  });
  it("leaves a running Windows app available and reports restart guidance", async () => {
    running = true;
    await expect(codexDesktop.spawn!([], routing())).rejects.toMatchObject({code: "AGENT_CONFIG_CONFLICT", hint: expect.stringContaining("PowerShell")});
    expect(await codexDesktop.isConfigured()).toBe(true);
    expect(mocks.run.mock.calls.some(([command, args]) => command === "powershell.exe" && /Start-Process|Stop-Process|CloseMainWindow/.test(args.at(-1) ?? ""))).toBe(false);
  });
  it("passes an explicit isolated profile to the Windows launch", async () => {
    running = true;
    const profile = join(home, "Isolated desktop profile");
    vi.stubEnv("CODEX_ELECTRON_USER_DATA_PATH", profile);
    await expect(codexDesktop.spawn!([], routing())).resolves.toBe(0);
    const launch = mocks.run.mock.calls.find(([command, args]) => command === "powershell.exe" && args.at(-1)?.includes("Start-Process"))?.[1].at(-1);
    expect(launch).toContain("CODEX_ELECTRON_USER_DATA_PATH");
    expect(launch).toContain("--user-data-dir=");
    expect(launch).toContain(profile);
  });
  it("rejects an outdated Windows bundled runtime before modifying config", async () => {
    const run = mocks.run.getMockImplementation()!;
    mocks.run.mockImplementation((command: string, args: string[]) => command === runtime ? ok("codex-cli 0.153.3\n") : run(command, args));
    await expect(codexDesktop.configure(options())).rejects.toMatchObject({code: "AGENT_NOT_FOUND", message: expect.stringContaining("0.153.3")});
    expect(configText()).toBe(ORIGINAL);
    expect(mocks.fetchCatalog).not.toHaveBeenCalled();
  });
  it("discovers a bundled runtime after its resource subdirectory moves", async () => {
    rmSync(runtime);
    runtime = join(appRoot, "resources", "runtime-v2", "tools", "codex.exe");
    mkdirSync(dirname(runtime), {recursive: true}); writeFileSync(runtime, "fixture");
    expect(await codexDesktop.detect()).toMatchObject({installed: true, version: "0.162.0"});
    expect(mocks.run).toHaveBeenCalledWith(runtime, ["--version"], {timeout: 5_000});
  });
  it("refuses Windows process-inspection failures without launching another app", async () => {
    const run = mocks.run.getMockImplementation()!;
    mocks.run.mockImplementation((command: string, args: string[]) => command === "powershell.exe" && args.at(-1)?.includes("Get-Process")
      ? {code: 1, stdout: "", stderr: "inspection failed"}
      : run(command, args));
    await expect(codexDesktop.spawn!([], routing())).rejects.toMatchObject({code: "AGENT_CONFIG_CONFLICT"});
    expect(mocks.run.mock.calls.some(([command, args]) => command === "powershell.exe" && args.at(-1)?.includes("Start-Process"))).toBe(false);
  });
  it("does not trust a manifest executable escaping the registered package", async () => {
    mocks.run.mockReturnValue(ok(JSON.stringify([{installLocation: dirname(appRoot), executable: "../outside.exe", aumid: "OpenAI.Codex_fixture!App"}])));
    expect(await codexDesktop.detect()).toMatchObject({installed: false});
  });
});
