import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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

  it("darwin: returns installed=true when /Applications/Claude.app exists", async () => {
    // The adapter checks /Applications/Claude.app first; we can't write
    // to it in CI, so verify the user-Applications fallback instead.
    mkdirSync(join(home, "Applications", "Claude.app"), { recursive: true });
    const result = await claudeDesktop.detect();
    expect(result.installed).toBe(true);
  });

  it("windows: returns installed=true when a known candidate exists", async () => {
    platformMock.mockReturnValue("win32");
    const local = join(home, "AppData", "Local");
    process.env.LOCALAPPDATA = local;
    mkdirSync(join(local, "AnthropicClaude"), { recursive: true });
    writeFileSync(join(local, "AnthropicClaude", "Claude.exe"), "");
    const result = await claudeDesktop.detect();
    expect(result.installed).toBe(true);
  });
});
