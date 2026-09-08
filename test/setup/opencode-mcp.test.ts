import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, openSync, closeSync, writeSync, ftruncateSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { configureOpenCode } from "../../src/setup/opencode.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, mkdir: vi.fn(original.mkdir), rename: vi.fn(original.rename), link: vi.fn(original.link) };
});

describe("explicit OpenCode MCP setup", () => {
  let sandbox: string;
  let previous: string | undefined;
  let directory: string;
  beforeEach(() => {
    previous = process.env.OPPER_EDITOR_HOME;
    sandbox = mkdtempSync(join(tmpdir(), "opper-mcp-setup-"));
    process.env.OPPER_EDITOR_HOME = sandbox;
    directory = join(sandbox, ".config", "opencode");
    mkdirSync(directory, { recursive: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(sandbox, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPPER_EDITOR_HOME;
    else process.env.OPPER_EDITOR_HOME = previous;
  });
  const load = (path: string) => parse(readFileSync(path, "utf8"));

  it("is opt-in and leaves permission discovery to Opper with a URL-only connection", async () => {
    let result = await configureOpenCode({ location: "global" });
    expect(load(result.path).mcp).toBeUndefined();
    result = await configureOpenCode({ location: "global", mcp: true });
    expect(load(result.path).mcp).toEqual({ opper: {
      type: "remote", url: "https://api.opper.ai/mcp", enabled: true,
    } });
    expect(result.mcpScopes).toBeUndefined();
    const original = readFileSync(result.path, "utf8");
    expect((await configureOpenCode({ location: "global", mcp: true })).wrote).toBe(false);
    expect(readFileSync(result.path, "utf8")).toBe(original);
  });

  it("does not overwrite a new config created after inspection", async () => {
    const fs = await import("node:fs/promises");
    const original = fs.mkdir;
    const path = join(directory, "opencode.json");
    const other = '{"model":"another-process/model"}';
    vi.spyOn(fs, "mkdir").mockImplementationOnce(async (...args) => {
      writeFileSync(path, other);
      return original(...args);
    });
    await expect(configureOpenCode({ location: "global", mcp: true })).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    expect(readFileSync(path, "utf8")).toBe(other);
  });

  it("preserves an existing config edited after the final inspection", async () => {
    const fs = await import("node:fs/promises");
    const original = fs.mkdir;
    const path = join(directory, "opencode.json");
    writeFileSync(path, '{"model":"initial/model"}');
    const edited = '{"model":"newer/model"}';
    vi.spyOn(fs, "mkdir").mockImplementationOnce(async (...args) => {
      writeFileSync(path, edited);
      return original(...args);
    });
    await expect(configureOpenCode({ location: "global", mcp: true })).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    expect(readFileSync(path, "utf8")).toBe(edited);
  });

  it("retains the original inode and permissions in a reported backup on update", async () => {
    const path = join(directory, "opencode.json");
    const raw = '{"model":"my/model"}';
    writeFileSync(path, raw, { mode: 0o640 });
    const originalInode = statSync(path).ino;
    const result = await configureOpenCode({ location: "global", mcp: true });
    expect(result.backupPath).toBeTruthy();
    expect(readFileSync(result.backupPath!, "utf8")).toBe(raw);
    expect(statSync(result.backupPath!).ino).toBe(originalInode);
    expect(statSync(path).ino).not.toBe(originalInode);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(load(path).mcp.opper.url).toBe("https://api.opper.ai/mcp");
  });

  it("restores a changed captured file only when the destination is still absent", async () => {
    const fs = await import("node:fs/promises");
    const original = fs.rename;
    const path = join(directory, "opencode.json");
    writeFileSync(path, '{"model":"initial/model"}');
    const edited = '{"model":"edited-after-capture/model"}';
    vi.spyOn(fs, "rename").mockImplementationOnce(async (source, destination) => {
      await original(source, destination);
      writeFileSync(destination, edited);
    });
    await expect(configureOpenCode({ location: "global", mcp: true })).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT", hint: expect.stringContaining("preserved at") });
    expect(readFileSync(path, "utf8")).toBe(edited);
  });

  it("keeps a concurrent atomic save and retains the captured original for recovery", async () => {
    const fs = await import("node:fs/promises");
    const original = fs.link;
    const path = join(directory, "opencode.json");
    const raw = '{"model":"initial/model"}';
    const edited = '{"model":"other-editor/model"}';
    writeFileSync(path, raw);
    vi.spyOn(fs, "link").mockImplementationOnce(async (source, destination) => {
      expect(existsSync(path)).toBe(false);
      writeFileSync(path, edited);
      return original(source, destination);
    });
    await expect(configureOpenCode({ location: "global", mcp: true })).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT", hint: expect.stringContaining("preserved at") });
    expect(readFileSync(path, "utf8")).toBe(edited);
    const saved = readdirSync(directory).find((name) => name.startsWith(".opper-mcp-"));
    expect(saved).toBeTruthy();
    expect(readFileSync(join(directory, saved!, "opencode.json.backup"), "utf8")).toBe(raw);
  });

  it("retains late writes through an old open file descriptor in the backup", async () => {
    const path = join(directory, "opencode.json");
    writeFileSync(path, '{"model":"initial/model"}');
    const handle = openSync(path, "r+");
    try {
      const result = await configureOpenCode({ location: "global", mcp: true });
      const later = '{"model":"late-in-place-save/model"}';
      ftruncateSync(handle, 0);
      writeSync(handle, later, 0, "utf8");
      expect(readFileSync(result.backupPath!, "utf8")).toBe(later);
      expect(load(path).mcp.opper.url).toBe("https://api.opper.ai/mcp");
    } finally { closeSync(handle); }
  });

  it("refuses to move a symlink config or change its target", async () => {
    const path = join(directory, "opencode.json");
    const target = join(directory, "dotfile");
    const raw = '{"model":"my/model"}';
    writeFileSync(target, raw);
    symlinkSync(target, path);
    await expect(configureOpenCode({ location: "global", mcp: true })).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(raw);
  });

  it("preserves provider, MCP entries, preferences, comments, and file permissions", async () => {
    const path = join(directory, "opencode.json");
    const raw = `{
      // My model preference
      "model": "other/model", "permission": { "*": "ask" },
      "provider": { "opper": { "options": { "baseURL": "https://private.example/v3/compat" } } },
      "mcp": { "work": { "type": "remote", "url": "https://work.example/mcp" } },
    }`;
    writeFileSync(path, raw, { mode: 0o600 });
    await configureOpenCode({ location: "global", mcp: true });
    const config = load(path);
    expect(readFileSync(path, "utf8")).toContain("// My model preference");
    expect(config.model).toBe("other/model");
    expect(config.permission).toEqual({ "*": "ask" });
    expect(config.provider.opper.options.baseURL).toBe("https://private.example/v3/compat");
    expect(config.mcp.work.url).toBe("https://work.example/mcp");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("merges normal JSON plus JSONC without duplicating a provider from the earlier file", async () => {
    const path = join(directory, "opencode.json");
    const raw = JSON.stringify({ provider: { opper: { custom: true } }, model: "other/model" });
    writeFileSync(path, raw);
    const jsonc = join(directory, "opencode.jsonc");
    writeFileSync(jsonc, '{\n  // Editor metadata\n  "$schema": "https://opencode.ai/config.json",\n}\n');
    const result = await configureOpenCode({ location: "global", mcp: true });
    expect(result.path).toBe(jsonc);
    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(load(jsonc).provider).toBeUndefined();
    expect(load(jsonc).mcp.opper.url).toBe("https://api.opper.ai/mcp");
    expect(readFileSync(jsonc, "utf8")).toContain("// Editor metadata");
  });

  it("reuses the effective existing MCP name without changing its disabled/auth preferences", async () => {
    const path = join(directory, "opencode.json");
    const raw = JSON.stringify({ provider: { opper: {} }, mcp: {
      opper_demo: { type: "remote", url: "http://localhost:8080/mcp", enabled: true, oauth: { scope: "controls:read" } },
    } });
    writeFileSync(path, raw);
    const jsonc = join(directory, "opencode.jsonc");
    const override = '{ "mcp": { "opper_demo": { "enabled": false } } }';
    writeFileSync(jsonc, override);
    const result = await configureOpenCode({ location: "global", mcp: true, mcpUrl: "http://localhost:8080/mcp" });
    expect(result).toMatchObject({ wrote: false, mcpName: "opper_demo" });
    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(readFileSync(jsonc, "utf8")).toBe(override);
  });

  it.each([
    '{not json', '[]', 'null', '{ "provider": [] }', '{ "mcp": "broken" }',
    '{ "model": "first", "model": "second" }',
  ])("refuses invalid or ambiguous config and leaves every file untouched (%s)", async (raw) => {
    const path = join(directory, "opencode.json");
    const jsonc = join(directory, "opencode.jsonc");
    writeFileSync(path, raw);
    writeFileSync(jsonc, '{ "autoupdate": false }');
    await expect(configureOpenCode({ location: "global", mcp: true, overwrite: true })).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(readFileSync(jsonc, "utf8")).toBe('{ "autoupdate": false }');
  });

  it.each(['https://staging.opper.ai/mcp', 'http://localhost:8080/mcp', 'http://127.0.0.1:8080/mcp', 'http://[::1]:8080/mcp'])
    ("accepts HTTPS and explicit loopback development overrides (%s)", async (url) => {
      const result = await configureOpenCode({ location: "global", mcp: true, mcpUrl: url });
      expect(load(result.path).mcp.opper.url).toBe(url);
    });

  it.each(['http://remote.example/mcp', 'ftp://localhost/mcp', 'https://user:secret@example.com/mcp', 'https://api.opper.ai/mcp#fragment', 'https://api.opper.ai/mcp?token=secret', ' https://api.opper.ai/mcp', 'http://local host:8080/mcp'])
    ("rejects invalid or credential-bearing URLs before any file write (%s)", async (mcpUrl) => {
      await expect(configureOpenCode({ location: "global", mcp: true, mcpUrl })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(existsSync(join(directory, "opencode.json"))).toBe(false);
    });

  it("requires explicit opt-in with --mcp-url and preserves a conflicting named server", async () => {
    await expect(configureOpenCode({ location: "global", mcpUrl: "http://localhost:8080/mcp" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const path = join(directory, "opencode.json");
    const raw = '{ "mcp": { "opper": { "type": "remote", "url": "https://custom.example/mcp" } } }';
    writeFileSync(path, raw);
    await expect(configureOpenCode({ location: "global", mcp: true, overwrite: true })).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  it("requests only explicitly selected scopes without silently adding permissions", async () => {
    const result = await configureOpenCode({ location: "global", mcp: true, mcpScopes: "runtime:read controls:read runtime:read" });
    expect(load(result.path).mcp.opper.oauth.scope).toBe("controls:read runtime:read");
    expect(result.mcpScopes).toBe("controls:read runtime:read");
  });

  it("updates only an existing server's OAuth scope across JSON and JSONC layers", async () => {
    const path = join(directory, "opencode.json");
    const raw = JSON.stringify({ provider: { opper: { custom: true } }, mcp: {
      opper_demo: { type: "remote", url: "https://api.opper.ai/mcp", enabled: false, oauth: { scope: "account:read projects:read", clientId: "registered-client" } },
      other: { type: "remote", url: "https://other.example/mcp" },
    } });
    writeFileSync(path, raw);
    const jsonc = join(directory, "opencode.jsonc");
    writeFileSync(jsonc, '{\n // MCP preferences\n "mcp": { "opper_demo": { "oauth": {\n // Fixed callback\n "redirectUri": "http://localhost:19876/mcp/oauth/callback",\n } } },\n}');
    const result = await configureOpenCode({ location: "global", mcp: true, mcpScopes: "account:read projects:read projects:write" });
    expect(result).toMatchObject({ wrote: true, mcpName: "opper_demo", mcpEnabled: false, mcpScopes: "account:read projects:read projects:write" });
    expect(readFileSync(path, "utf8")).toBe(raw);
    const updated = readFileSync(jsonc, "utf8");
    expect(updated).toContain("// MCP preferences");
    expect(updated).toContain("// Fixed callback");
    expect(load(jsonc).mcp).toEqual({ opper_demo: { oauth: { redirectUri: "http://localhost:19876/mcp/oauth/callback", scope: "account:read projects:read projects:write" } } });
    expect((await configureOpenCode({ location: "global", mcp: true, mcpScopes: "account:read projects:read projects:write" })).wrote).toBe(false);
    expect(readFileSync(jsonc, "utf8")).toBe(updated);
    await configureOpenCode({ location: "global", mcp: true, mcpScopes: "account:read" });
    expect(load(jsonc).mcp.opper_demo.oauth.scope).toBe("account:read");
  });

  it.each(["", " ", "*", "account:read projects:write unknown:write", "account:read,projects:read"])
    ("rejects invalid scope selections before changing config (%s)", async (mcpScopes) => {
      await expect(configureOpenCode({ location: "global", mcp: true, mcpScopes })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      expect(existsSync(join(directory, "opencode.json"))).toBe(false);
    });

  it("requires --mcp for an explicit scope selection", async () => {
    await expect(configureOpenCode({ location: "global", mcpScopes: "account:read" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(existsSync(join(directory, "opencode.json"))).toBe(false);
  });

  it.each([false, "invalid", []])("preserves explicit OAuth disablement or invalid settings (%s)", async (oauth) => {
    const path = join(directory, "opencode.json");
    const raw = JSON.stringify({ mcp: { opper: { type: "remote", url: "https://api.opper.ai/mcp", oauth } } });
    writeFileSync(path, raw);
    expect((await configureOpenCode({ location: "global", mcp: true })).wrote).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(raw);
    await expect(configureOpenCode({ location: "global", mcp: true, mcpScopes: "account:read" })).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    expect(readFileSync(path, "utf8")).toBe(raw);
  });
});
