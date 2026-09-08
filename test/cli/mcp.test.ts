import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import registerMcp from "../../src/cli/mcp.js";
import registerEditors from "../../src/cli/editors.js";

describe("MCP command configuration", () => {
  let directory: string;
  let configPath: string;
  const context = { key: () => "default", version: "test" };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "opper-mcp-command-"));
    vi.stubEnv("OPPER_EDITOR_HOME", directory);
    vi.stubEnv("OPPER_HOME", join(directory, ".opper"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("MCP setup must not use the network"));
    configPath = join(directory, ".config", "opencode", "opencode.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  function run(args: string[]) {
    const program = new Command().exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerMcp(program, context);
    registerEditors(program, context);
    return program.parseAsync(args, { from: "user" });
  }

  function seed(text: string) {
    mkdirSync(join(directory, ".config", "opencode"), { recursive: true });
    writeFileSync(configPath, text);
  }

  it("adds account MCP without configuring inference, fetching models, or logging in", async () => {
    await run(["mcp", "add", "opencode"]);
    expect(parse(readFileSync(configPath, "utf8"))).toEqual({
      mcp: { opper: { type: "remote", url: "https://api.opper.ai/mcp", enabled: true } },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(existsSync(join(directory, ".opper"))).toBe(false);
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain("choose permissions in Opper");
  });

  it("accepts a local endpoint and explicit permission ceiling", async () => {
    await run(["mcp", "add", "opencode", "--global", "--url", "http://localhost:8080/mcp", "--scopes", "projects:read account:read"]);
    expect(parse(readFileSync(configPath, "utf8")).mcp.opper).toEqual({
      type: "remote", url: "http://localhost:8080/mcp", enabled: true,
      oauth: { scope: "account:read projects:read" },
    });
  });

  it("writes project config only when --local is selected", async () => {
    const project = join(directory, "project");
    mkdirSync(project);
    vi.spyOn(process, "cwd").mockReturnValue(project);
    await run(["mcp", "add", "opencode", "--local"]);
    expect(existsSync(join(project, "opencode.json"))).toBe(true);
    expect(existsSync(configPath)).toBe(false);
  });

  it("keeps the legacy editor command equivalent, including its existing flag names", async () => {
    const original = '{\n // Keep my provider\n "model": "other/model", "provider": {"other": {}},\n}';
    seed(original);
    await run(["mcp", "add", "opencode", "--url", "http://localhost:8080/mcp", "--scopes", "account:read"]);
    const canonical = readFileSync(configPath, "utf8");
    seed(original);
    await run(["editors", "opencode", "--mcp", "--mcp-url", "http://localhost:8080/mcp", "--mcp-scopes", "account:read"]);
    expect(readFileSync(configPath, "utf8")).toBe(canonical);
    expect(canonical).toContain("// Keep my provider");
    expect(parse(canonical).model).toBe("other/model");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("preserves a matching connection's name and disabled state on repeated setup", async () => {
    const original = JSON.stringify({ mcp: { demo: {
      type: "remote", url: "https://api.opper.ai/mcp", enabled: false,
      oauth: { scope: "account:read" },
    } } });
    seed(original);
    await run(["mcp", "add", "opencode"]);
    await run(["mcp", "add", "opencode"]);
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain("disabled");
  });

  it.each([
    { args: ["mcp", "add", "opencode"], enabled: true },
    { args: ["mcp", "add", "opencode"], enabled: false },
    { args: ["editors", "opencode", "--mcp"], enabled: true },
  ])("explains preserved OAuth disablement for $args with enabled=$enabled", async ({ args, enabled }) => {
    const original = JSON.stringify({ mcp: { demo: {
      type: "remote", url: "https://api.opper.ai/mcp", enabled, oauth: false,
    } } });
    seed(original);
    await run(args);
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("OAuth is disabled for demo");
    expect(output).toContain("oauth: false");
    expect(output).not.toContain("opencode mcp auth");
    expect(output).not.toContain("choose permissions in Opper");
    if (!enabled) expect(output).toContain("connection is disabled. Enable it in OpenCode");
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(["claude", "unknown"])("rejects unsupported client %s without writing config", async (client) => {
    await expect(run(["mcp", "add", client])).rejects.toMatchObject({ code: "commander.invalidArgument" });
    expect(existsSync(configPath)).toBe(false);
  });

  it("rejects conflicting location flags before writing", async () => {
    await expect(run(["mcp", "add", "opencode", "--local", "--global"])).rejects.toMatchObject({ code: "commander.conflictingOption" });
    expect(existsSync(configPath)).toBe(false);
  });

  it("rejects unquoted extra scopes instead of silently dropping permissions", async () => {
    await expect(run(["mcp", "add", "opencode", "--scopes", "account:read", "projects:read"])).rejects.toMatchObject({ code: "commander.excessArguments" });
    expect(existsSync(configPath)).toBe(false);
  });

  it("rejects unknown options without writing", async () => {
    await expect(run(["mcp", "add", "opencode", "--mcp-url", "http://localhost:8080/mcp"])).rejects.toMatchObject({ code: "commander.unknownOption" });
    expect(existsSync(configPath)).toBe(false);
  });

  it("leaves malformed configuration untouched", async () => {
    seed("{broken");
    await expect(run(["mcp", "add", "opencode"])).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    expect(readFileSync(configPath, "utf8")).toBe("{broken");
  });
});
