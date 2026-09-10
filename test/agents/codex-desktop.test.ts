import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { readDesktopConfig } from "../../src/setup/codex-desktop-config.js";
import { setSlot, deleteSlot } from "../../src/auth/config.js";
import { OpperError } from "../../src/errors.js";

const mocks = vi.hoisted(() => {
  const { existsSync } = require("node:fs") as typeof import("node:fs");
  return {
    realExists: existsSync,
    platform: vi.fn(() => "darwin"),
    homedir: vi.fn(() => "/nonexistent"),
    run: vi.fn(),
    fetchCatalog: vi.fn(),
    apps: new Set<string>(),
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
    if (path.startsWith("/Applications/")) {
      return [...mocks.apps].some((app) => path === app || path.startsWith(`${app}/`));
    }
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
  return () => spawnSync(auth.command, auth.args, {
    encoding: "utf8", timeout: 5_000,
    // Finder has neither the launch shell's key nor its Opper home override.
    env: { PATH: process.env.PATH ?? "", HOME: join(home, "finder-home") },
  });
}
function allText(directory: string): string {
  return readdirSync(directory, { withFileTypes: true }).map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? allText(path) : readFileSync(path, "utf8");
  }).join("\n");
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
  appRunning = false;
  bundleId = "com.openai.codex";
  runtimeVersion = "0.153.4";
  mocks.run.mockReset();
  mocks.run.mockImplementation((command: string, args: string[]) => {
    if (command.endsWith("plutil")) return ok(args.includes("CFBundleExecutable") ? "ChatGPT" : bundleId);
    if (command.endsWith("/codex") && args.includes("--version")) return ok(`codex-cli ${runtimeVersion}\n`);
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
  it("accepts the combined ChatGPT app with the Codex bundle and supported runtime", async () => {
    expect(await codexDesktop.detect()).toMatchObject({ installed: true });
    expect(mocks.run.mock.calls.some(([command]) => command === "/Applications/ChatGPT.app/Contents/Resources/codex")).toBe(true);
  });

  it("also finds the separate Codex app", async () => {
    mocks.apps.clear();
    mocks.apps.add("/Applications/Codex.app");
    expect(await codexDesktop.detect()).toMatchObject({ installed: true });
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
    const matched = spawnSync("grep", ["-E", processArgs[1]!], {
      input: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --some-argument\n",
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
