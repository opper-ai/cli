import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { setSlot } from "../../src/auth/config.js";
import { useTempOpperHome } from "../helpers/temp-home.js";

const hermesDetect = vi.fn();
const hermesIsConfigured = vi.fn().mockResolvedValue(false);
const desktopPrepare = vi.fn();
const desktopOpen = vi.fn();
const configureCopilot = vi.fn();
vi.mock("../../src/setup/github-copilot-vscode.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/setup/github-copilot-vscode.js")>(),
  configureGitHubCopilotVSCode: configureCopilot,
}));
vi.mock("../../src/commands/desktop.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/commands/desktop.js")>(),
  prepareDesktopProxy: desktopPrepare, desktopOpenCommand: desktopOpen,
}));
vi.mock("../../src/agents/registry.js", () => ({
  listAdapters: () => [
    {
      name: "hermes",
      displayName: "Hermes Agent",
      docsUrl: "https://hermes-agent.nousresearch.com/docs/",
      detect: hermesDetect,
      isConfigured: hermesIsConfigured,
      configure: vi.fn(),
      unconfigure: vi.fn(),
      install: vi.fn(),
      spawn: vi.fn(),
    },
  ],
  getAdapter: vi.fn(),
}));

const { agentsListCommand } = await import("../../src/commands/agents.js");

const hermesUnconfigure = vi.fn();
const getAdapterMock = vi.mocked(
  (await import("../../src/agents/registry.js")).getAdapter,
);

describe("agentsListCommand", () => {
  it("prints each adapter with installed status, slug, and launch command", async () => {
    hermesDetect.mockResolvedValue({
      installed: true,
      version: "1.0.0",
      configPath: "/home/user/.hermes/config.yaml",
    });
    hermesIsConfigured.mockResolvedValue(true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await agentsListCommand();
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("hermes"); // slug column
      expect(out).toContain("Hermes Agent"); // display name
      expect(out).toContain("1.0.0"); // version inline
      expect(out.toLowerCase()).toContain("installed");
      expect(out).toContain("opper launch hermes"); // launch command shown per row
    } finally {
      log.mockRestore();
    }
  });

  it("marks adapters as not installed when detect() says so", async () => {
    hermesDetect.mockResolvedValue({ installed: false });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await agentsListCommand();
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out.toLowerCase()).toContain("not installed");
    } finally {
      log.mockRestore();
    }
  });

  it("prints a usable setup command for a configure-only Conductor integration", async () => {
    const registry = await import("../../src/agents/registry.js");
    vi.spyOn(registry, "listAdapters").mockReturnValueOnce([{
      name: "conductor", displayName: "Conductor (Codex)", docsUrl: "https://www.conductor.build",
      detect: vi.fn().mockResolvedValue({ installed: true }),
      isConfigured: vi.fn().mockResolvedValue(false), configure: vi.fn(), unconfigure: vi.fn(),
    }]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await agentsListCommand();
      const output = log.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("opper agents configure conductor");
      expect(output).not.toContain("opper editors conductor");
    } finally { log.mockRestore(); }
  });
});

describe("agentsRemoveCommand", () => {
  beforeEach(() => {
    hermesUnconfigure.mockReset();
    getAdapterMock.mockReset();
  });

  it("calls unconfigure on the resolved adapter", async () => {
    getAdapterMock.mockReturnValue({
      name: "hermes",
      displayName: "Hermes Agent",
      docsUrl: "https://example.com",
      detect: vi.fn(),
      isConfigured: vi.fn(),
      configure: vi.fn(),
      unconfigure: hermesUnconfigure,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { agentsRemoveCommand } = await import(
        "../../src/commands/agents.js"
      );
      await agentsRemoveCommand("hermes");
      expect(hermesUnconfigure).toHaveBeenCalledExactlyOnceWith();
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("Hermes Agent");
      expect(out).toContain("removed");
    } finally {
      log.mockRestore();
    }
  });

  it("forwards an explicit desktop home on removal without changing CODEX_HOME", async () => {
    const homeBefore = process.env.CODEX_HOME;
    getAdapterMock.mockReturnValue({
      name: "codex-desktop", displayName: "Codex Desktop", docsUrl: "https://example.com",
      detect: vi.fn(), isConfigured: vi.fn(), configure: vi.fn(), unconfigure: hermesUnconfigure,
    });
    const { agentsRemoveCommand } = await import("../../src/commands/agents.js");
    await agentsRemoveCommand("codex-desktop", "/tmp/selected Codex home");
    expect(hermesUnconfigure).toHaveBeenCalledExactlyOnceWith({ codexHome: "/tmp/selected Codex home" });
    expect(process.env.CODEX_HOME).toBe(homeBefore);
  });

  it("rejects --codex-home for other adapters before removing anything", async () => {
    getAdapterMock.mockReturnValue({
      name: "hermes", displayName: "Hermes", docsUrl: "https://example.com",
      detect: vi.fn(), isConfigured: vi.fn(), configure: vi.fn(), unconfigure: hermesUnconfigure,
    });
    const { agentsRemoveCommand } = await import("../../src/commands/agents.js");
    await expect(agentsRemoveCommand("hermes", "/tmp/custom"))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT", message: expect.stringContaining("--codex-home") });
    expect(hermesUnconfigure).not.toHaveBeenCalled();
  });

  it("throws AGENT_NOT_FOUND for unknown adapter names", async () => {
    getAdapterMock.mockReturnValue(null);
    const { agentsRemoveCommand } = await import(
      "../../src/commands/agents.js"
    );
    await expect(agentsRemoveCommand("nope")).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  });
});

describe("agentsConfigureCommand", () => {
  const opperHome = useTempOpperHome();
  const configure = vi.fn();
  const unconfigure = vi.fn();
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    desktopPrepare.mockReset(); desktopOpen.mockReset().mockResolvedValue({ url: "http://127.0.0.1:12345/open/fresh" });
    vi.stubEnv("OPPER_API_KEY", undefined);
    vi.stubEnv("OPPER_BASE_URL", undefined);
    configure.mockReset().mockResolvedValue(undefined);
    unconfigure.mockReset();
    getAdapterMock.mockReset();
    getAdapterMock.mockReturnValue({
      name: "codex-desktop",
      displayName: "Codex Desktop",
      docsUrl: "https://example.com",
      detect: vi.fn(),
      isConfigured: vi.fn(),
      configure,
      unconfigure,
    });
    log = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    vi.unstubAllEnvs();
  });

  it("configures opt-in proxy routing without launching the app and opens a fresh picker after setup", async () => {
    const proxy = { baseUrl: "http://127.0.0.1:12345", token: "local-token", stateDir: "/tmp/proxy" };
    const projectUuid = "11111111-1111-4111-8111-111111111111";
    await setSlot("prod", { apiKey: "real-key", baseUrl: "https://api.opper.ai" });
    desktopPrepare.mockResolvedValue({ proxy });
    const { agentsConfigureCommand } = await import("../../src/commands/agents.js");
    await agentsConfigureCommand("codex-desktop", "prod", "claude-sonnet-5", "/tmp/home", projectUuid, { proxy: true, stateDir: "/tmp/proxy", open: false });
    expect(desktopPrepare).toHaveBeenCalledExactlyOnceWith({ key: "prod", stateDir: "/tmp/proxy", projectUuid });
    expect(configure).toHaveBeenCalledExactlyOnceWith({ keyName: "prod", apiKey: "real-key", baseUrl: "https://api.opper.ai", projectUuid, model: "claude-sonnet-5", codexHome: "/tmp/home", desktopProxy: proxy });
    expect(desktopOpen).toHaveBeenCalledExactlyOnceWith({ key: "prod", stateDir: "/tmp/proxy", projectUuid, open: false });
    expect(configure.mock.invocationCallOrder[0]).toBeLessThan(desktopOpen.mock.invocationCallOrder[0]!);
  });

  it("keeps configuration direct by default and never starts a proxy", async () => {
    await setSlot("prod", { apiKey: "real-key" });
    const { agentsConfigureCommand } = await import("../../src/commands/agents.js");
    await agentsConfigureCommand("codex-desktop", "prod");
    expect(configure.mock.calls[0]![0]).not.toHaveProperty("desktopProxy");
    expect(desktopPrepare).not.toHaveBeenCalled(); expect(desktopOpen).not.toHaveBeenCalled();
  });

  it("lets a signed-out user run the advertised VS Code Copilot setup command", async () => {
    const registry = await import("../../src/agents/registry.js");
    vi.spyOn(registry, "listAdapters").mockReturnValueOnce([{
      name: "github-copilot-vscode", displayName: "GitHub Copilot (VS Code)", docsUrl: "https://github.com/features/copilot",
      detect: vi.fn().mockResolvedValue({installed: true}), isConfigured: vi.fn().mockResolvedValue(false),
      configure, unconfigure,
    }]);
    configureCopilot.mockReset().mockResolvedValue({path: "/tmp/copilot-test-settings.json", wrote: true});
    const copilot = (await import("../../src/agents/github-copilot-vscode.js")).githubCopilotVSCode;
    const detect = vi.spyOn(copilot, "detect").mockResolvedValue({installed: true});
    await agentsListCommand();
    const row = log.mock.calls.map(call => String(call[0])).find(text => text.includes("github-copilot-vscode"))!;
    const args = row.slice(row.indexOf("opper ")).replace(/\u001b\[[0-9;]*m/g, "").trim().split(/\s+/).slice(1);
    const cli = new Command().exitOverride();
    const context = {key: () => "missing", version: "test"};
    (await import("../../src/cli/agents.js")).default(cli, context);
    (await import("../../src/cli/editors.js")).default(cli, context);
    try { await cli.parseAsync(args, {from: "user"}); }
    finally { detect.mockRestore(); }
    expect(configureCopilot).toHaveBeenCalledExactlyOnceWith({channel: "stable"});
    expect(configure).not.toHaveBeenCalled();
  });

  it.each(["conductor", "codex-desktop", "opencode", "pi"].flatMap(agent => ["all", "pools,routes"].map(modelKinds => [agent, modelKinds])))("forwards %s catalog selection %s", async (agent, modelKinds) => {
    getAdapterMock.mockReturnValue({ name: agent, displayName: "Conductor", docsUrl: "https://example.com", detect: vi.fn(), isConfigured: vi.fn(), configure, unconfigure });
    await setSlot("prod", { apiKey: "fixture-prod" });
    const { agentsConfigureCommand } = await import("../../src/commands/agents.js");
    await agentsConfigureCommand(agent, "prod", undefined, undefined, undefined, { modelKinds });
    expect(configure).toHaveBeenCalledExactlyOnceWith({ keyName: "prod", apiKey: "fixture-prod", baseUrl: "https://api.opper.ai", modelKinds });
  });

  it.each([
    ["conductor", "models"], ["conductor", ""], ["conductor", "pools"],
    ["claude", "all"], ["hermes", "pools,routes"],
  ])("rejects unsupported catalog selection for %s (%s) before credentials or writes", async (agent, modelKinds) => {
    getAdapterMock.mockReturnValue({ name: agent, displayName: agent, docsUrl: "https://example.com", detect: vi.fn(), isConfigured: vi.fn(), configure, unconfigure });
    const { agentsConfigureCommand } = await import("../../src/commands/agents.js");
    await expect(agentsConfigureCommand(agent, "missing", undefined, undefined, undefined, { modelKinds }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT", message: expect.stringContaining("--model-kinds") });
    expect(configure).not.toHaveBeenCalled();
    expect(desktopPrepare).not.toHaveBeenCalled();
  });

  it.each([{ proxy: true }, { stateDir: "/tmp/proxy" }, { open: false }])("rejects unsupported proxy options before credentials or writes (%j)", async (opts) => {
    getAdapterMock.mockReturnValue({ name: "codex", displayName: "Codex", docsUrl: "https://example.com", detect: vi.fn(), isConfigured: vi.fn(), configure, unconfigure });
    const { agentsConfigureCommand } = await import("../../src/commands/agents.js");
    await expect(agentsConfigureCommand("codex", "missing", undefined, undefined, undefined, opts)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(configure).not.toHaveBeenCalled(); expect(desktopPrepare).not.toHaveBeenCalled();
  });

  it("forwards an independent environment credential without borrowing the selected slot host", async () => {
    await setSlot("default", { apiKey: "fixture-default", baseUrl: "https://default.example" });
    await setSlot("prod", { apiKey: "fixture-prod", baseUrl: "https://prod.example/tenant" });
    vi.stubEnv("OPPER_API_KEY", "fixture-unrelated-shell-key");
    const { agentsConfigureCommand } = await import("../../src/commands/agents.js");
    await agentsConfigureCommand("codex-desktop", "prod", "claude-sonnet-5");
    expect(getAdapterMock).toHaveBeenCalledWith("codex-desktop");
    expect(configure).toHaveBeenCalledExactlyOnceWith({
      keyName: "prod", apiKey: "fixture-unrelated-shell-key", baseUrl: "https://api.opper.ai", model: "claude-sonnet-5",
    });
    expect(unconfigure).not.toHaveBeenCalled();
  });

  it("forwards an explicit API host override with the same stored key", async () => {
    await setSlot("prod", { apiKey: "fixture-prod", baseUrl: "https://stored.example" });
    vi.stubEnv("OPPER_BASE_URL", "https://override.example/api");
    const { agentsConfigureCommand } = await import("../../src/commands/agents.js");
    await agentsConfigureCommand("codex-desktop", "prod", "claude-opus-5");
    expect(configure).toHaveBeenCalledExactlyOnceWith({
      keyName: "prod", apiKey: "fixture-prod", baseUrl: "https://override.example/api", model: "claude-opus-5",
    });
  });

  it("forwards an explicit desktop home on configuration without changing CODEX_HOME", async () => {
    await setSlot("prod", { apiKey: "fixture-prod" });
    const homeBefore = process.env.CODEX_HOME;
    const { agentsConfigureCommand } = await import("../../src/commands/agents.js");
    await agentsConfigureCommand("codex-desktop", "prod", undefined, "/tmp/selected Codex home");
    expect(configure).toHaveBeenCalledExactlyOnceWith({
      keyName: "prod", apiKey: "fixture-prod", baseUrl: "https://api.opper.ai", codexHome: "/tmp/selected Codex home",
    });
    expect(process.env.CODEX_HOME).toBe(homeBefore);
  });

  it("rejects --codex-home for other adapters before resolving credentials", async () => {
    getAdapterMock.mockReturnValue({
      name: "codex", displayName: "Codex CLI", docsUrl: "https://example.com",
      detect: vi.fn(), isConfigured: vi.fn(), configure, unconfigure,
    });
    const { agentsConfigureCommand } = await import("../../src/commands/agents.js");
    await expect(agentsConfigureCommand("codex", "missing", undefined, "/tmp/custom"))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT", message: expect.stringContaining("--codex-home") });
    expect(configure).not.toHaveBeenCalled();
    expect(unconfigure).not.toHaveBeenCalled();
  });

  it("uses the production root and leaves model selection to the adapter when omitted", async () => {
    await setSlot("prod", { apiKey: "fixture-prod" });
    const { agentsConfigureCommand } = await import("../../src/commands/agents.js");
    await agentsConfigureCommand("codex-desktop", "prod");
    expect(configure).toHaveBeenCalledExactlyOnceWith({
      keyName: "prod", apiKey: "fixture-prod", baseUrl: "https://api.opper.ai",
    });
  });

  it("does not configure, remove or alter stored credentials when the selected slot is missing", async () => {
    await setSlot("default", { apiKey: "fixture-default" });
    const path = join(opperHome.get(), "config.json");
    const before = readFileSync(path, "utf8");
    const { agentsConfigureCommand } = await import("../../src/commands/agents.js");
    await expect(agentsConfigureCommand("codex-desktop", "missing", "claude-sonnet-5"))
      .rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(configure).not.toHaveBeenCalled();
    expect(unconfigure).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(log).not.toHaveBeenCalled();
  });

  it("rejects unknown adapters without configuring an integration", async () => {
    getAdapterMock.mockReturnValue(null);
    const { agentsConfigureCommand } = await import("../../src/commands/agents.js");
    await expect(agentsConfigureCommand("unknown", "prod")).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
    expect(configure).not.toHaveBeenCalled();
    expect(unconfigure).not.toHaveBeenCalled();
  });
});
