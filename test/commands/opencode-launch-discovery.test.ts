import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  fstatSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setSlot } from "../../src/auth/config.js";

// Keep launch, credential resolution, HTTP requests, and config writes real.
// Only the OS subprocess boundary and the remote gateway are substituted.
const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return { ...actual, spawnSync: spawnSyncMock };
});

const { launchCommand } = await import("../../src/commands/launch.js");

interface CapturedConfig {
  theme?: string;
  provider: {
    opper: {
      models: Record<string, unknown>;
      options: { apiKey: string; baseURL: string };
    };
    other?: unknown;
  };
}

describe("OpenCode launch model discovery", () => {
  let sandbox: string;
  let previousCwd: string;
  let configPath: string;
  let child: { apiKey: string | undefined; config: CapturedConfig; inline: any } | undefined;
  let preflightResult: { status: number | null; stdout: string; stderr?: string; error?: Error } | undefined;
  const fetchMock = vi.fn<typeof fetch>();
  const selectedKey = "op_live_selected_test_key";
  const selectedHost = "https://selected.opper.test/gateway";
  const originalConfig = { theme: "user-theme", provider: { other: { name: "Other" } } };

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "opper-launch-discovery-"));
    // Capture cleanup assertions must not observe other parallel suites.
    vi.stubEnv("TMPDIR", sandbox);
    vi.stubEnv("TEMP", sandbox);
    vi.stubEnv("TMP", sandbox);
    previousCwd = process.cwd();
    const project = join(sandbox, "project");
    mkdirSync(project);
    process.chdir(project);
    vi.stubEnv("OPPER_HOME", join(sandbox, "opper"));
    vi.stubEnv("OPPER_EDITOR_HOME", join(sandbox, "editor"));
    vi.stubEnv("OPPER_API_KEY", undefined);
    vi.stubEnv("OPPER_BASE_URL", undefined);
    child = undefined;
    preflightResult = undefined;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_input, init) => {
      const key = new Headers(init?.headers).get("Authorization");
      const id = key === `Bearer ${selectedKey}` ? "allowed/selected-model" : "other/foreign-model";
      return new Response(JSON.stringify({
        data: [{
          id,
          context_length: 128_000,
          pricing: { prompt: "0.000001", completion: "0.000002" },
          opper: { kind: "model", type: "llm", capabilities: ["tools"] },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    spawnSyncMock.mockReset();
    spawnSyncMock.mockImplementation((command: string, args: string[], opts: { env?: NodeJS.ProcessEnv; stdio?: unknown[] }) => {
      if ((command === "which" || command === "where") && args[0] === "opencode") {
        return { status: 0, stdout: "/test/bin/opencode\n", stderr: "" };
      }
      if (command !== "opencode") throw new Error(`Unexpected subprocess: ${command}`);
      if (args[0] === "debug" && args[1] === "config") {
        const result = preflightResult ?? { status: 0, stdout: opts.env?.OPENCODE_CONFIG_CONTENT ?? "{}", stderr: "" };
        if (typeof opts.stdio?.[1] === "number") writeFileSync(opts.stdio[1], result.stdout);
        return { ...result, stdout: result.stdout.slice(0, 65536) };
      }
      child = {
        apiKey: opts.env?.OPPER_API_KEY,
        config: JSON.parse(readFileSync(configPath, "utf8")) as CapturedConfig,
        inline: JSON.parse(opts.env?.OPENCODE_CONFIG_CONTENT || "{}"),
      };
      return { status: 0 };
    });
  });

  afterEach(() => {
    process.chdir(previousCwd);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(sandbox, { recursive: true, force: true });
  });

  for (const scope of ["user", "project"] as const) {
    describe(`${scope} config`, () => {
      beforeEach(() => {
        configPath = scope === "project"
          ? join(process.cwd(), "opencode.json")
          : join(sandbox, "editor", ".config", "opencode", "opencode.json");
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, JSON.stringify(originalConfig));
      });

      async function launchAndCheck(expectedHost: string): Promise<void> {
        const exitCode = await launchCommand({
          agent: "opencode",
          key: "team",
          configScope: scope,
          model: "allowed/selected-model",
          tags: { customer: "acme", team: "eu" },
          passthrough: ["models", "opper"],
        });

        expect(exitCode).toBe(0);
        expect(child).toBeDefined();
        expect(child!.apiKey).toBe(selectedKey);
        expect(child!.config.provider.opper.options.apiKey).toBe("{env:OPPER_API_KEY}");
        const inferenceUrl = child!.config.provider.opper.options.baseURL;
        expect(inferenceUrl.startsWith(`${expectedHost}/v3/session/sess_`)).toBe(true);
        expect(inferenceUrl.endsWith("/customer:acme/team:eu")).toBe(true);

        // The discovery URL must be on the launch host, before session/tag
        // decoration. Its identity must be the identity actually sent to the
        // child, even when other key slots or ambient credentials exist.
        const discoveries = fetchMock.mock.calls.filter(([input]) => String(input).includes("/compat/models"));
        expect(discoveries).toHaveLength(1);
        const [url, init] = discoveries[0]!;
        expect.soft(String(url)).toBe(`${expectedHost}/v3/compat/models`);
        expect.soft(init?.method).toBe("GET");
        expect.soft(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${child!.apiKey}`);
        expect.soft(Object.keys(child!.config.provider.opper.models)).toEqual(["allowed/selected-model"]);
        // Runtime content is loaded after project and custom config files.
        expect(child!.inline.provider.opper.whitelist).toEqual(["allowed/selected-model"]);
        expect(child!.inline.provider.opper.models).toBeUndefined();
        expect(child!.inline.provider.opper.options.baseURL).toBe(inferenceUrl);
        expect(child!.inline.provider.opper.options.apiKey).toBe("{env:OPPER_API_KEY}");
        expect(child!.config.theme).toBe(originalConfig.theme);
        expect(child!.config.provider.other).toEqual(originalConfig.provider.other);

        if (scope === "user") {
          expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(originalConfig);
        }
      }

      it("removes inherited authorization headers without dropping unrelated headers", async () => {
        await setSlot("team", { apiKey: selectedKey, baseUrl: selectedHost });
        vi.stubEnv("OPENCODE_CONFIG_CONTENT", JSON.stringify({ provider: { opper: { options: {
          headers: { Authorization: "Bearer stale", authorization: "Bearer stale-lower", AUTHORIZATION: "Bearer stale-upper", "X-Custom": "keep" },
        } } } }));
        await launchAndCheck(selectedHost);
        expect(child!.inline.provider.opper.options.headers).toEqual({ "X-Custom": "keep" });
      });

      it.each([
        { location: "provider", opper: { options: { headers: { aUtHoRiZaTiOn: "Bearer secret-stale-provider" } } } },
        { location: "model", opper: { models: { "allowed/selected-model": { headers: { AUTHORIZATION: "Bearer secret-stale-model" } } } } },
        { location: "model options", opper: { models: { "allowed/selected-model": { options: { headers: { authorization: "Bearer secret-stale-options" } } } } } },
      ])("rejects effective $location authorization headers before changing config or starting inference", async ({ opper }) => {
        await setSlot("team", { apiKey: selectedKey, baseUrl: selectedHost });
        preflightResult = { status: 0, stdout: JSON.stringify({ provider: { opper } }) };
        const originalBytes = readFileSync(configPath, "utf8");
        await expect(launchCommand({ agent: "opencode", key: "team", configScope: scope })).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
        expect(child).toBeUndefined();
        expect(readFileSync(configPath, "utf8")).toBe(originalBytes);
      });

      it.each([
        { status: 1, stdout: "secret config stdout", stderr: "secret config stderr" },
        { status: null, stdout: "", error: new Error("secret spawn error") },
        { status: null, stdout: "secret partial config", error: Object.assign(new Error("secret timeout"), { code: "ETIMEDOUT" }) },
        { status: 0, stdout: "secret malformed config" },
      ])("fails closed without leaking output when effective configuration cannot be inspected: %j", async (result) => {
        await setSlot("team", { apiKey: selectedKey, baseUrl: selectedHost });
        preflightResult = result;
        const capturesBefore = readdirSync(tmpdir()).filter((name) => name.startsWith("opper-opencode-inspect-"));
        const originalBytes = readFileSync(configPath, "utf8");
        let caught: unknown;
        try {
          await launchCommand({ agent: "opencode", key: "team", configScope: scope });
        } catch (error) {
          caught = error;
        }
        expect(caught).toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
        expect(String(caught)).not.toContain("secret");
        expect(readdirSync(tmpdir()).filter((name) => name.startsWith("opper-opencode-inspect-"))).toEqual(capturesBefore);
        expect(child).toBeUndefined();
        expect(readFileSync(configPath, "utf8")).toBe(originalBytes);
      });

      it("inspects large configuration output and removes its private capture", async () => {
        await setSlot("team", { apiKey: selectedKey, baseUrl: selectedHost });
        preflightResult = { status: 0, stdout: JSON.stringify({ padding: "x".repeat(500_000) }) };
        const before = readdirSync(tmpdir()).filter((name) => name.startsWith("opper-opencode-inspect-"));
        const implementation = spawnSyncMock.getMockImplementation()!;
        let descriptor: number | undefined;
        spawnSyncMock.mockImplementation((command, args, opts) => {
          if (command === "opencode" && args[0] === "debug") {
            expect(opts.timeout).toBe(30_000);
            descriptor = opts.stdio[1];
            expect(typeof descriptor).toBe("number");
            expect(fstatSync(descriptor!).mode & 0o777).toBe(0o600);
          }
          return implementation(command, args, opts);
        });
        await launchAndCheck(selectedHost);
        expect(() => fstatSync(descriptor!)).toThrow();
        expect(readdirSync(tmpdir()).filter((name) => name.startsWith("opper-opencode-inspect-"))).toEqual(before);
      });

      it("rejects an Authorization header beyond the first 64 KB of configuration", async () => {
        await setSlot("team", { apiKey: selectedKey, baseUrl: selectedHost });
        preflightResult = { status: 0, stdout: JSON.stringify({
          padding: "x".repeat(500_000),
          provider: { opper: { models: {
            "allowed/selected-model": { options: { headers: { AUTHORIZATION: "secret conflicting credential" } } },
          } } },
        }) };
        const originalBytes = readFileSync(configPath, "utf8");
        await expect(launchCommand({ agent: "opencode", key: "team", configScope: scope })).rejects.toMatchObject({
          code: "AGENT_CONFIG_CONFLICT",
          message: expect.stringContaining("contains an Authorization header"),
        });
        expect(child).toBeUndefined();
        expect(readFileSync(configPath, "utf8")).toBe(originalBytes);
        expect(readdirSync(tmpdir()).filter((name) => name.startsWith("opper-opencode-inspect-"))).toEqual([]);
      });

      it("discovers with the selected key and host instead of the default slot", async () => {
        await setSlot("default", {
          apiKey: "op_live_default_test_key",
          baseUrl: "https://default.opper.test",
        });
        await setSlot("team", { apiKey: selectedKey, baseUrl: selectedHost });

        await launchAndCheck(selectedHost);
      });

      it("discovers models when the selected named slot is the only stored slot", async () => {
        await setSlot("team", { apiKey: selectedKey, baseUrl: selectedHost });

        await launchAndCheck(selectedHost);
      });

      it("keeps discovery aligned with child credentials and the effective host despite ambient credentials", async () => {
        await setSlot("default", { apiKey: "op_live_default_test_key" });
        await setSlot("team", { apiKey: selectedKey, baseUrl: selectedHost });
        vi.stubEnv("OPPER_API_KEY", "op_live_ambient_test_key");
        vi.stubEnv("OPPER_BASE_URL", "https://override.opper.test/proxy");

        await launchAndCheck("https://override.opper.test/proxy");
      });

      it("preserves unrelated inline JSONC settings while replacing stale Opper routing and whitelist", async () => {
        await setSlot("team", { apiKey: selectedKey, baseUrl: selectedHost });
        vi.stubEnv("OPENCODE_CONFIG_CONTENT", `{
          // Existing per-process preferences
          "instructions": ["keep.md"],
          "provider": {
            "other": {"name": "Keep other provider"},
            "opper": {
              "whitelist": ["revoked-model"],
              "options": {"baseURL": "https://old.example", "apiKey": "old-key", "headers": {"X-Custom": "keep"}}
            }
          },
        }`);
        await launchAndCheck(selectedHost);
        expect(child!.inline.instructions).toEqual(["keep.md"]);
        expect(child!.inline.provider.other).toEqual({ name: "Keep other provider" });
        expect(child!.inline.provider.opper.options.headers).toEqual({ "X-Custom": "keep" });
      });

      it("leaves config untouched if existing inline configuration is invalid", async () => {
        await setSlot("team", { apiKey: selectedKey, baseUrl: selectedHost });
        vi.stubEnv("OPENCODE_CONFIG_CONTENT", "{invalid");
        const originalBytes = readFileSync(configPath, "utf8");
        await expect(launchCommand({ agent: "opencode", key: "team", configScope: scope })).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
        expect(child).toBeUndefined();
        expect(readFileSync(configPath, "utf8")).toBe(originalBytes);
      });

      it("keeps a large catalog out of the runtime environment variable", async () => {
        await setSlot("team", { apiKey: selectedKey, baseUrl: selectedHost });
        const data = Array.from({ length: 800 }, (_, index) => ({
          id: `provider/model-${index}`,
          context_length: 128_000,
          pricing: { prompt: "0.000001", completion: "0.000002" },
          opper: { kind: "model", type: "llm", capabilities: ["tools"] },
        }));
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ data })));
        await launchCommand({ agent: "opencode", key: "team", configScope: scope });
        expect(Object.keys(child!.config.provider.opper.models)).toHaveLength(800);
        expect(child!.inline.provider.opper.whitelist).toHaveLength(800);
        // Linux limits each environment string to 128 KiB on 4 KiB pages.
        expect(Buffer.byteLength(JSON.stringify(child!.inline))).toBeLessThan(128 * 1024);
      });

      it.each([
        { failure: "rejected credentials", httpStatus: 401, code: "AUTH_EXPIRED" },
        { failure: "gateway unavailability", httpStatus: 503, code: "API_ERROR" },
        { failure: "a network failure", httpStatus: undefined, code: "NETWORK_ERROR" },
      ])("does not spawn or change config after $failure during discovery", async ({ httpStatus, code }) => {
        // Both slots deliberately work here, so this isolates failed discovery
        // handling from the separate selected-slot regressions above.
        await setSlot("default", { apiKey: selectedKey, baseUrl: selectedHost });
        await setSlot("team", { apiKey: selectedKey, baseUrl: selectedHost });
        if (httpStatus === undefined) {
          fetchMock.mockRejectedValue(new Error("Gateway connection unavailable"));
        } else {
          fetchMock.mockResolvedValue(new Response(JSON.stringify({
            error: { message: "Discovery unavailable" },
          }), { status: httpStatus }));
        }
        const originalBytes = readFileSync(configPath, "utf8");

        await expect.soft(launchCommand({
          agent: "opencode",
          key: "team",
          configScope: scope,
        })).rejects.toMatchObject({ code });

        expect.soft(spawnSyncMock.mock.calls.filter(([command]) => command === "opencode")).toHaveLength(0);
        expect.soft(readFileSync(configPath, "utf8")).toBe(originalBytes);
      });
    });
  }
});
