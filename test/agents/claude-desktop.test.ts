import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { readFileSync as readFileSyncReal } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { platformMock, homedirMock, existsSyncMock } = vi.hoisted(() => {
  // Capture the real existsSync before any mocking happens
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { existsSync: realExistsSync } = require("node:fs") as typeof import("node:fs");
  const existsSyncMock = vi.fn<[string], boolean>((p: string) => realExistsSync(p));
  return {
    platformMock: vi.fn<[], NodeJS.Platform>(() => "darwin"),
    homedirMock: vi.fn<[], string>(() => "/nonexistent"),
    existsSyncMock,
  };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, platform: platformMock, homedir: homedirMock };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: existsSyncMock };
});

const { claudeDesktop } = await import("../../src/agents/claude-desktop.js");

function makeTempHome(): string {
  return mkdtempSync(join(tmpdir(), "opper-claude-desktop-"));
}

describe("claude-desktop adapter — detect", () => {
  let home: string;

  beforeEach(() => {
    platformMock.mockReturnValue("darwin");
    home = makeTempHome();
    homedirMock.mockReturnValue(home);
    // Reset to real fs behaviour, but always report /Applications/Claude.app
    // as absent so CI and developer machines both behave identically.
    existsSyncMock.mockReset();
    existsSyncMock.mockImplementation((p: string) => {
      if (p === "/Applications/Claude.app") return false;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { existsSync: real } = require("node:fs") as { existsSync: (p: string) => boolean };
      return real(p);
    });
  });

  it("returns installed=false on linux regardless of fs state", async () => {
    platformMock.mockReturnValue("linux");
    expect((await claudeDesktop.detect()).installed).toBe(false);
  });

  it("darwin: returns installed=false when no Claude.app candidate exists", async () => {
    expect((await claudeDesktop.detect()).installed).toBe(false);
  });

  it("darwin: returns installed=true when ~/Applications/Claude.app exists", async () => {
    // /Applications/Claude.app is forced absent by the existsSync mock in
    // beforeEach; this test exercises the user-Applications fallback instead.
    mkdirSync(join(home, "Applications", "Claude.app"), { recursive: true });
    const result = await claudeDesktop.detect();
    expect(result.installed).toBe(true);
  });

  it("windows: returns installed=true when a known candidate exists", async () => {
    const prev = process.env.LOCALAPPDATA;
    try {
      platformMock.mockReturnValue("win32");
      const local = join(home, "AppData", "Local");
      process.env.LOCALAPPDATA = local;
      mkdirSync(join(local, "AnthropicClaude"), { recursive: true });
      writeFileSync(join(local, "AnthropicClaude", "Claude.exe"), "");
      const result = await claudeDesktop.detect();
      expect(result.installed).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = prev;
    }
  });
});

describe("claude-desktop adapter — paths (via isConfigured)", () => {
  let home: string;

  beforeEach(() => {
    platformMock.mockReturnValue("darwin");
    home = makeTempHome();
    homedirMock.mockReturnValue(home);
  });

  it("returns false when no config files exist (fresh tree)", async () => {
    expect(await claudeDesktop.isConfigured()).toBe(false);
  });
});

describe("claude-desktop adapter — isConfigured", () => {
  let home: string;

  beforeEach(() => {
    platformMock.mockReturnValue("darwin");
    home = makeTempHome();
    homedirMock.mockReturnValue(home);
  });

  it("returns false on a fresh tree", async () => {
    expect(await claudeDesktop.isConfigured()).toBe(false);
  });

  it("returns true after configure()", async () => {
    await claudeDesktop.configure({ apiKey: "op_test_key" });
    expect(await claudeDesktop.isConfigured()).toBe(true);
  });

  it("returns false when only the normal config is in 3p mode (incomplete)", async () => {
    const base = join(home, "Library", "Application Support");
    mkdirSync(join(base, "Claude"), { recursive: true });
    writeFileSync(
      join(base, "Claude", "claude_desktop_config.json"),
      JSON.stringify({ deploymentMode: "3p" }),
    );
    expect(await claudeDesktop.isConfigured()).toBe(false);
  });
});

describe("claude-desktop adapter — configure", () => {
  let home: string;

  beforeEach(() => {
    platformMock.mockReturnValue("darwin");
    home = makeTempHome();
    homedirMock.mockReturnValue(home);
  });

  function readJSON(path: string): any {
    return JSON.parse(readFileSyncReal(path, "utf8"));
  }

  it("throws AUTH_REQUIRED when called without an apiKey", async () => {
    await expect(claudeDesktop.configure({})).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });

  it("writes deploymentMode=3p to both normal and 3p config files", async () => {
    await claudeDesktop.configure({ apiKey: "op_test_key" });
    const base = join(home, "Library", "Application Support");
    expect(readJSON(join(base, "Claude", "claude_desktop_config.json"))).toMatchObject({
      deploymentMode: "3p",
    });
    expect(readJSON(join(base, "Claude-3p", "claude_desktop_config.json"))).toMatchObject({
      deploymentMode: "3p",
    });
  });

  it("writes the Opper entry into _meta.json and sets appliedId", async () => {
    await claudeDesktop.configure({ apiKey: "op_test_key" });
    const meta = readJSON(
      join(home, "Library", "Application Support", "Claude-3p", "configLibrary", "_meta.json"),
    );
    expect(meta.appliedId).toBe("727f05c8-a429-43cc-b1c6-36d8883d98b8");
    expect(meta.entries).toContainEqual({
      id: "727f05c8-a429-43cc-b1c6-36d8883d98b8",
      name: "Opper",
    });
  });

  it("writes the gateway profile JSON with Opper's compat URL and the api key", async () => {
    await claudeDesktop.configure({ apiKey: "op_test_key" });
    const profile = readJSON(
      join(
        home,
        "Library",
        "Application Support",
        "Claude-3p",
        "configLibrary",
        "727f05c8-a429-43cc-b1c6-36d8883d98b8.json",
      ),
    );
    expect(profile).toMatchObject({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "https://api.opper.ai/v3/compat",
      inferenceGatewayApiKey: "op_test_key",
      inferenceGatewayAuthScheme: "bearer",
      disableDeploymentModeChooser: true,
    });
  });

  it("preserves user-owned siblings in the normal config and _meta.json", async () => {
    const base = join(home, "Library", "Application Support");
    const normalCfg = join(base, "Claude", "claude_desktop_config.json");
    mkdirSync(join(base, "Claude"), { recursive: true });
    writeFileSync(
      normalCfg,
      JSON.stringify({ mcpServers: { fs: { command: "fs" } } }, null, 2),
    );
    const metaPath = join(base, "Claude-3p", "configLibrary", "_meta.json");
    mkdirSync(join(base, "Claude-3p", "configLibrary"), { recursive: true });
    writeFileSync(
      metaPath,
      JSON.stringify({ entries: [{ id: "user-other", name: "Other" }] }, null, 2),
    );

    await claudeDesktop.configure({ apiKey: "op_test_key" });

    expect(readJSON(normalCfg)).toMatchObject({
      mcpServers: { fs: { command: "fs" } },
      deploymentMode: "3p",
    });
    const meta = readJSON(metaPath);
    expect(meta.entries).toContainEqual({ id: "user-other", name: "Other" });
    expect(meta.entries).toContainEqual({
      id: "727f05c8-a429-43cc-b1c6-36d8883d98b8",
      name: "Opper",
    });
  });

  it("is idempotent — running twice does not duplicate the Opper entry", async () => {
    await claudeDesktop.configure({ apiKey: "op_test_key" });
    await claudeDesktop.configure({ apiKey: "op_test_key" });
    const meta = readJSON(
      join(home, "Library", "Application Support", "Claude-3p", "configLibrary", "_meta.json"),
    );
    const opperEntries = (meta.entries as Array<{ id: string }>).filter(
      (e) => e.id === "727f05c8-a429-43cc-b1c6-36d8883d98b8",
    );
    expect(opperEntries).toHaveLength(1);
  });
});

describe("claude-desktop adapter — unconfigure", () => {
  let home: string;

  beforeEach(() => {
    platformMock.mockReturnValue("darwin");
    home = makeTempHome();
    homedirMock.mockReturnValue(home);
  });

  function readJSON(path: string): any {
    return JSON.parse(readFileSyncReal(path, "utf8"));
  }

  it("is a no-op on a fresh tree (no errors, no writes)", async () => {
    await expect(claudeDesktop.unconfigure()).resolves.toBeUndefined();
  });

  it("flips deploymentMode back to 1p in both config files", async () => {
    await claudeDesktop.configure({ apiKey: "op_test_key" });
    await claudeDesktop.unconfigure();
    const base = join(home, "Library", "Application Support");
    expect(readJSON(join(base, "Claude", "claude_desktop_config.json"))).toMatchObject({
      deploymentMode: "1p",
    });
    expect(readJSON(join(base, "Claude-3p", "claude_desktop_config.json"))).toMatchObject({
      deploymentMode: "1p",
    });
  });

  it("removes the Opper entry from _meta.json and clears appliedId", async () => {
    await claudeDesktop.configure({ apiKey: "op_test_key" });
    await claudeDesktop.unconfigure();
    const meta = readJSON(
      join(home, "Library", "Application Support", "Claude-3p", "configLibrary", "_meta.json"),
    );
    expect(meta.appliedId).toBeUndefined();
    const opperEntries = (meta.entries as Array<{ id: string }>).filter(
      (e) => e.id === "727f05c8-a429-43cc-b1c6-36d8883d98b8",
    );
    expect(opperEntries).toHaveLength(0);
  });

  it("preserves user-owned _meta.json entries", async () => {
    const base = join(home, "Library", "Application Support");
    mkdirSync(join(base, "Claude-3p", "configLibrary"), { recursive: true });
    writeFileSync(
      join(base, "Claude-3p", "configLibrary", "_meta.json"),
      JSON.stringify({ entries: [{ id: "user-other", name: "Other" }] }),
    );
    await claudeDesktop.configure({ apiKey: "op_test_key" });
    await claudeDesktop.unconfigure();
    const meta = readJSON(
      join(base, "Claude-3p", "configLibrary", "_meta.json"),
    );
    expect(meta.entries).toContainEqual({ id: "user-other", name: "Other" });
  });

  it("blanks the gateway fields in the profile JSON", async () => {
    await claudeDesktop.configure({ apiKey: "op_test_key" });
    await claudeDesktop.unconfigure();
    const profile = readJSON(
      join(
        home,
        "Library",
        "Application Support",
        "Claude-3p",
        "configLibrary",
        "727f05c8-a429-43cc-b1c6-36d8883d98b8.json",
      ),
    );
    expect(profile.inferenceProvider).toBeUndefined();
    expect(profile.inferenceGatewayBaseUrl).toBeUndefined();
    expect(profile.inferenceGatewayApiKey).toBeUndefined();
    expect(profile.inferenceGatewayAuthScheme).toBeUndefined();
    expect(profile.disableDeploymentModeChooser).toBe(false);
  });

  it("isConfigured returns false after unconfigure", async () => {
    await claudeDesktop.configure({ apiKey: "op_test_key" });
    expect(await claudeDesktop.isConfigured()).toBe(true);
    await claudeDesktop.unconfigure();
    expect(await claudeDesktop.isConfigured()).toBe(false);
  });
});

describe("claude-desktop adapter — install / spawn arg guards", () => {
  beforeEach(() => {
    platformMock.mockReturnValue("darwin");
    homedirMock.mockReturnValue(makeTempHome());
  });

  it("install throws AGENT_NOT_FOUND with the manual-install hint", async () => {
    await expect(claudeDesktop.install!()).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
      hint: expect.stringContaining("claude.ai/download"),
    });
  });

  it("spawn rejects passthrough arguments", async () => {
    const ROUTING = {
      baseUrl: "https://api.opper.ai/v3/compat",
      apiKey: "op_test_key",
      model: "claude-opus-4-7",
      compatShape: "openai" as const,
    };
    await expect(claudeDesktop.spawn!(["foo"], ROUTING)).rejects.toMatchObject({
      message: expect.stringContaining("does not accept"),
    });
  });
});
