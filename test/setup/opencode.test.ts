import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import {
  configureOpenCode,
  readProjectConfigState,
} from "../../src/setup/opencode.js";
import { opencodeConfigPath } from "../../src/util/editor-paths.js";

describe("configureOpenCode", () => {
  let home: string;
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.OPPER_EDITOR_HOME;
    home = mkdtempSync(join(tmpdir(), "opper-opencode-"));
    process.env.OPPER_EDITOR_HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (prev === undefined) delete process.env.OPPER_EDITOR_HOME;
    else process.env.OPPER_EDITOR_HOME = prev;
  });

  it("writes the template to the global location and creates the directory", async () => {
    const result = await configureOpenCode({ location: "global" });
    const expected = opencodeConfigPath("global");
    expect(result.path).toBe(expected);
    expect(result.wrote).toBe(true);
    expect(existsSync(expected)).toBe(true);
    const parsed = JSON.parse(readFileSync(expected, "utf8"));
    expect(parsed.provider).toBeDefined();
    const { readFileSync: readFileSync2 } = await import("node:fs");
    const { assetPath } = await import("../../src/util/assets.js");
    expect(readFileSync2(expected, "utf8")).toBe(
      readFileSync2(assetPath("opencode.json"), "utf8"),
    );
  });

  it("refuses to overwrite an existing Opper provider unless overwrite=true", async () => {
    const target = opencodeConfigPath("global");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      target,
      JSON.stringify({ provider: { opper: { existing: true } } }),
      "utf8",
    );

    const without = await configureOpenCode({ location: "global" });
    expect(without.wrote).toBe(false);
    expect(without.reason).toBe("exists");

    const withOverride = await configureOpenCode({
      location: "global",
      overwrite: true,
    });
    expect(withOverride.wrote).toBe(true);
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    expect(parsed.provider.opper.existing).toBeUndefined();
  });

  it("leaves an existing JSONC Opper provider byte-for-byte unchanged without overwrite", async () => {
    const target = opencodeConfigPath("global");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    const jsonc = `{
  // User's configuration must remain untouched.
  "theme": "tokyonight",
  "provider": { "opper": { "existing": true, }, },
}\n`;
    writeFileSync(target, jsonc);

    const result = await configureOpenCode({ location: "global" });

    expect.soft(result).toEqual({ path: target, wrote: false, reason: "exists" });
    expect.soft(readFileSync(target, "utf8")).toBe(jsonc);
  });

  it.each([
    { action: "adds a new provider key", hasProviders: false, overwrite: false },
    { action: "adds Opper alongside another provider", hasProviders: true, overwrite: false },
    { action: "overwrites the existing Opper provider", hasProviders: true, overwrite: true },
  ])("preserves unrelated JSONC settings and comments when it $action", async ({ hasProviders, overwrite }) => {
    const target = opencodeConfigPath("global");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    const providerBlock = hasProviders ? `
  "provider": {
    // Keep the other provider's settings.
    "openrouter": { "npm": "@openrouter/ai-sdk-provider", },
    ${overwrite ? '"opper": { "stale": true, },' : ""}
  },` : "";
    const jsonc = `{
  // Keep the chosen theme.
  "theme": "tokyonight",
  "model": "anthropic/claude-sonnet-4-5",
  /* Keep the MCP endpoint. */
  "mcp": { "docs": { "url": "https://docs.example.test/path//literal", }, },
  "agent": { "build": { "mode": "primary", }, },${providerBlock}
}\n`;
    writeFileSync(target, jsonc);
    const models = { "allowed/model": { name: "Allowed model" } };

    const result = await configureOpenCode({ location: "global", overwrite, models });

    expect(result.wrote).toBe(true);
    const written = readFileSync(target, "utf8");
    const errors: ParseError[] = [];
    const config = parse(written, errors, { allowTrailingComma: true });
    expect(errors).toEqual([]);
    expect.soft(config.theme).toBe("tokyonight");
    expect.soft(config.model).toBe("anthropic/claude-sonnet-4-5");
    expect.soft(config.mcp).toEqual({ docs: { url: "https://docs.example.test/path//literal" } });
    expect.soft(config.agent).toEqual({ build: { mode: "primary" } });
    if (hasProviders) {
      expect.soft(config.provider.openrouter).toEqual({ npm: "@openrouter/ai-sdk-provider" });
      expect.soft(written).toContain("// Keep the other provider's settings.");
    }
    expect(config.provider.opper.models).toEqual(models);
    expect(config.provider.opper.whitelist).toEqual(["allowed/model"]);
    expect(config.provider.opper.stale).toBeUndefined();
    expect.soft(written).toContain("// Keep the chosen theme.");
    expect.soft(written).toContain("/* Keep the MCP endpoint. */");
  });

  it.each([false, true])("rejects malformed existing config and preserves its bytes with overwrite=%s", async (overwrite) => {
    const target = opencodeConfigPath("global");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    const malformed = '{\n  // An unfinished user edit.\n  "theme": "tokyonight",\n  "provider": {\n';
    writeFileSync(target, malformed, "utf8");

    await expect(configureOpenCode({ location: "global", overwrite })).rejects.toThrow();

    expect(readFileSync(target, "utf8")).toBe(malformed);
  });

  it.each([false, true])("rejects duplicate provider keys and preserves their bytes with overwrite=%s", async (overwrite) => {
    const target = opencodeConfigPath("global");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    const ambiguous = `{
  // A duplicated provider must not be edited ambiguously.
  "provider": {
    "opper": { "models": { "first/model": {}, }, },
    "opper": { "models": { "last/model": {}, }, },
  },
}\n`;
    writeFileSync(target, ambiguous);

    await expect(configureOpenCode({
      location: "global",
      overwrite,
      models: { "allowed/model": { name: "Allowed model" } },
    })).rejects.toThrow();

    expect(readFileSync(target, "utf8")).toBe(ambiguous);
  });

  it("grafts the Opper provider into an existing config that has no provider key", async () => {
    const target = opencodeConfigPath("global");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      target,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        theme: "tokyonight",
        model: "anthropic/claude-sonnet-4-5",
      }),
      "utf8",
    );

    const result = await configureOpenCode({ location: "global" });
    expect(result.wrote).toBe(true);

    const parsed = JSON.parse(readFileSync(target, "utf8"));
    expect(parsed.theme).toBe("tokyonight");
    expect(parsed.model).toBe("anthropic/claude-sonnet-4-5");
    expect(parsed.provider.opper.options.baseURL).toBe(
      "https://api.opper.ai/v3/compat",
    );
  });

  it("grafts the Opper provider into an existing config without dropping unrelated keys", async () => {
    const target = opencodeConfigPath("global");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      target,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        theme: "tokyonight",
        model: "anthropic/claude-sonnet-4-5",
        provider: {
          openrouter: { npm: "@openrouter/ai-sdk-provider", name: "OpenRouter" },
        },
        agent: { build: { mode: "primary" } },
      }),
      "utf8",
    );

    const result = await configureOpenCode({ location: "global" });
    expect(result.wrote).toBe(true);

    const parsed = JSON.parse(readFileSync(target, "utf8"));
    expect(parsed.theme).toBe("tokyonight");
    expect(parsed.model).toBe("anthropic/claude-sonnet-4-5");
    expect(parsed.provider.openrouter).toBeDefined();
    expect(parsed.provider.opper).toBeDefined();
    expect(parsed.provider.opper.options.baseURL).toBe(
      "https://api.opper.ai/v3/compat",
    );
    expect(parsed.agent.build.mode).toBe("primary");
  });

  describe("readProjectConfigState", () => {
    it("reports exists=false for a missing file", () => {
      const state = readProjectConfigState(join(home, "missing.json"));
      expect(state).toEqual({ exists: false, hasOpperProvider: false });
    });

    it("reports hasOpperProvider=false when the file lacks the opper provider", () => {
      const target = join(home, "opencode.json");
      writeFileSync(
        target,
        JSON.stringify({
          theme: "tokyonight",
          model: "anthropic/claude-sonnet-4-5",
        }),
        "utf8",
      );
      expect(readProjectConfigState(target)).toEqual({
        exists: true,
        hasOpperProvider: false,
      });
    });

    it("reports hasOpperProvider=true when the file has the opper provider", () => {
      const target = join(home, "opencode.json");
      writeFileSync(
        target,
        JSON.stringify({ provider: { opper: { id: "opper" } } }),
        "utf8",
      );
      expect(readProjectConfigState(target)).toEqual({
        exists: true,
        hasOpperProvider: true,
      });
    });

    it("recognizes an Opper provider in JSONC with comments and trailing commas", () => {
      const target = join(home, "opencode.json");
      writeFileSync(target, `{
  // Valid OpenCode configuration.
  "provider": { "opper": { "id": "opper", }, },
}\n`);

      expect(readProjectConfigState(target)).toEqual({
        exists: true,
        hasOpperProvider: true,
      });
    });

    it("treats unparseable files as exists=true / hasOpperProvider=false", () => {
      const target = join(home, "opencode.json");
      writeFileSync(target, "{not json", "utf8");
      expect(readProjectConfigState(target)).toEqual({
        exists: true,
        hasOpperProvider: false,
      });
    });
  });

  it("replaces only the Opper provider when overwrite=true is set on a populated config", async () => {
    const target = opencodeConfigPath("global");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      target,
      JSON.stringify({
        theme: "tokyonight",
        model: "anthropic/claude-sonnet-4-5",
        provider: {
          openrouter: { npm: "@openrouter/ai-sdk-provider" },
          opper: { stale: true },
        },
      }),
      "utf8",
    );

    const result = await configureOpenCode({
      location: "global",
      overwrite: true,
    });
    expect(result.wrote).toBe(true);

    const parsed = JSON.parse(readFileSync(target, "utf8"));
    expect(parsed.theme).toBe("tokyonight");
    expect(parsed.model).toBe("anthropic/claude-sonnet-4-5");
    expect(parsed.provider.openrouter).toBeDefined();
    expect(parsed.provider.opper.stale).toBeUndefined();
    expect(parsed.provider.opper.options.baseURL).toBe(
      "https://api.opper.ai/v3/compat",
    );
  });

  it("writes a models override on a FRESH install, not just when merging", async () => {
    // The fresh-install path wrote the asset verbatim, so an override applied
    // only when a config already existed — backwards from the common case.
    const models = { "dynamic/my-route": { name: "My Route (route)" } };
    const res = await configureOpenCode({ location: "global", overwrite: true, models });
    const cfg = JSON.parse(readFileSync(res.path, "utf8"));
    expect(Object.keys(cfg.provider.opper.models)).toEqual(["dynamic/my-route"]);
    expect(cfg.provider.opper.whitelist).toEqual(["dynamic/my-route"]);
  });

  it("applies the override again when a config already exists", async () => {
    const models = { "claude-sonnet-5": { name: "Claude Sonnet 5" } };
    await configureOpenCode({ location: "global", overwrite: true });
    const res = await configureOpenCode({ location: "global", overwrite: true, models });
    const cfg = JSON.parse(readFileSync(res.path, "utf8"));
    expect(Object.keys(cfg.provider.opper.models)).toEqual(["claude-sonnet-5"]);
    expect(cfg.provider.opper.whitelist).toEqual(["claude-sonnet-5"]);
  });

  it("removes models from the whitelist when access is revoked, including all access", async () => {
    await configureOpenCode({ location: "global", overwrite: true, models: {
      "allowed-model": { name: "Allowed" },
      "revoked-model": { name: "Revoked" },
    } });
    const result = await configureOpenCode({ location: "global", overwrite: true, models: {
      "allowed-model": { name: "Allowed" },
    } });
    expect(JSON.parse(readFileSync(result.path, "utf8")).provider.opper.whitelist).toEqual(["allowed-model"]);

    await configureOpenCode({ location: "global", overwrite: true, models: {} });
    const config = JSON.parse(readFileSync(result.path, "utf8"));
    expect(config.provider.opper.models).toEqual({});
    expect(config.provider.opper.whitelist).toEqual([]);
  });

  it("keeps the bundled list when no override is supplied", async () => {
    const res = await configureOpenCode({ location: "global", overwrite: true });
    const cfg = JSON.parse(readFileSync(res.path, "utf8"));
    expect(Object.keys(cfg.provider.opper.models).length).toBeGreaterThan(0);
    expect(cfg.provider.opper.options.baseURL).toBe("https://api.opper.ai/v3/compat");
  });
});
