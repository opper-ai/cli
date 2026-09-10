import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setSlot } from "../../src/auth/config.js";
import { useTempOpperHome } from "../helpers/temp-home.js";

const hermesDetect = vi.fn();
const hermesIsConfigured = vi.fn().mockResolvedValue(false);
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

  it("forwards the explicitly selected stored key, host and model", async () => {
    await setSlot("default", { apiKey: "fixture-default", baseUrl: "https://default.example" });
    await setSlot("prod", { apiKey: "fixture-prod", baseUrl: "https://prod.example/tenant" });
    vi.stubEnv("OPPER_API_KEY", "fixture-unrelated-shell-key");
    const { agentsConfigureCommand } = await import("../../src/commands/agents.js");
    await agentsConfigureCommand("codex-desktop", "prod", "claude-sonnet-5");
    expect(getAdapterMock).toHaveBeenCalledWith("codex-desktop");
    expect(configure).toHaveBeenCalledExactlyOnceWith({
      keyName: "prod", apiKey: "fixture-prod", baseUrl: "https://prod.example/tenant", model: "claude-sonnet-5",
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
