import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpperLoginPlugin } from "../../data/opencode-login-plugin.js";

let home: string;
let oldHome: string | undefined;
let oldKey: string | undefined;
let oldBase: string | undefined;
let oldSlot: string | undefined;
let oldOpperHome: string | undefined;
let oldLaunch: string | undefined;
let oldProject: string | undefined;

const catalog = (ids: string[]) => ({ data: ids.map((id) => ({
  id,
  context_length: 200_000,
  pricing: { prompt: "0.000001", completion: "0.000002" },
  opper: { type: "llm", capabilities: ["tools"] },
})) });

async function slot(data: Record<string, unknown>) {
  const directory = join(home, ".opper");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "config.json"), JSON.stringify({
    version: 1, defaultKey: "default", keys: { default: data },
  }));
}

async function run(config: Record<string, any>) {
  const plugin = await OpperLoginPlugin();
  await plugin.config(config);
  return config;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "opper-opencode-plugin-"));
  oldHome = process.env.OPPER_EDITOR_HOME;
  oldKey = process.env.OPPER_API_KEY;
  oldBase = process.env.OPPER_BASE_URL;
  oldSlot = process.env.OPPER_KEY_SLOT;
  oldOpperHome = process.env.OPPER_HOME;
  oldLaunch = process.env.OPPER_CLI_LAUNCH_OPENCODE;
  oldProject = process.env.OPPER_PROJECT_UUID;
  process.env.OPPER_EDITOR_HOME = home;
  delete process.env.OPPER_API_KEY;
  delete process.env.OPPER_BASE_URL;
  delete process.env.OPPER_KEY_SLOT;
  delete process.env.OPPER_HOME;
  delete process.env.OPPER_CLI_LAUNCH_OPENCODE;
  delete process.env.OPPER_PROJECT_UUID;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (oldHome === undefined) delete process.env.OPPER_EDITOR_HOME;
  else process.env.OPPER_EDITOR_HOME = oldHome;
  if (oldKey === undefined) delete process.env.OPPER_API_KEY;
  else process.env.OPPER_API_KEY = oldKey;
  if (oldBase === undefined) delete process.env.OPPER_BASE_URL;
  else process.env.OPPER_BASE_URL = oldBase;
  if (oldSlot === undefined) delete process.env.OPPER_KEY_SLOT;
  else process.env.OPPER_KEY_SLOT = oldSlot;
  if (oldOpperHome === undefined) delete process.env.OPPER_HOME;
  else process.env.OPPER_HOME = oldOpperHome;
  if (oldLaunch === undefined) delete process.env.OPPER_CLI_LAUNCH_OPENCODE;
  else process.env.OPPER_CLI_LAUNCH_OPENCODE = oldLaunch;
  if (oldProject === undefined) delete process.env.OPPER_PROJECT_UUID;
  else process.env.OPPER_PROJECT_UUID = oldProject;
  await rm(home, { recursive: true, force: true });
});

describe("OpenCode login plugin", () => {
  it("removes unsupported client-inferred request defaults without changing valid choices", async () => {
    await slot({ apiKey: "synthetic-key" });
    const data = [{ ...catalog(["openai/gpt-5.4"]).data[0], opper: { capabilities: ["reasoning"] } },
      { ...catalog(["pool"]).data[0], opper: { reasoning: { supported: ["high"] } } }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data }) }));
    const plugin = await OpperLoginPlugin();
    await plugin.config({});
    for (const [id, effort, expected] of [["openai/gpt-5.4", "medium", undefined], ["pool", "medium", undefined], ["pool", "high", "high"]]) {
      const output = { options: { reasoningEffort: effort, textVerbosity: "low" } };
      await plugin["chat.params"]({ model: { providerID: "opper", id } }, output);
      expect(output.options.reasoningEffort).toBe(expected);
      expect(output.options.textVerbosity).toBe("low");
    }
  });

  it("matches the CLI effort mapper and preserves custom variants on catalog refresh", async () => {
    await slot({ apiKey: "synthetic-key" });
    const data = [
      { ...catalog(["gpt-6.1-sol"]).data[0], opper: { kind: "pool", capabilities: ["reasoning", "tools"], reasoning: { supported: ["low", "medium", "high", "xhigh", "max"], default: "medium" } } },
      { ...catalog(["mixed-pool"]).data[0], opper: { kind: "pool", reasoning: { supported: ["high"], default: "max" } } },
      { ...catalog(["missing-metadata"]).data[0], opper: { capabilities: ["reasoning"] } },
      { id: "dynamic/unknown", opper: { kind: "dynamic_route", reasoning: { supported: ["max"], default: "max" } } },
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data }) }));
    const { toOpenCodeModels } = await import("../../src/setup/opencode-models.js");
    expect((await run({})).provider.opper.models).toEqual(toOpenCodeModels(data as any));
    const config = await run({ provider: { opper: { models: {
      "gpt-6.1-sol": { variants: { careful: { reasoningEffort: "high", temperature: 0 }, high: { textVerbosity: "low" } } },
      "mixed-pool": { variants: { max: { reasoningEffort: "max" } } },
      revoked: { variants: { personal: { temperature: 0 } } },
    } } } });
    expect(config.provider.opper.models["gpt-6.1-sol"].variants.careful).toEqual({ reasoningEffort: "high", temperature: 0 });
    expect(config.provider.opper.models["gpt-6.1-sol"].variants.high).toEqual({ reasoningEffort: "high", textVerbosity: "low" });
    expect(config.provider.opper.models["mixed-pool"].variants.max).toMatchObject({ disabled: true });
    expect(config.provider.opper.models.revoked).toBeUndefined();
  });

  it("strips saved model and variant credentials/routing while keeping benign headers and options", async () => {
    await slot({ apiKey: "synthetic-key" });
    const data = [{ ...catalog(["pool"]).data[0], opper: { reasoning: { supported: ["high"] } } }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data }) }));
    const stale = { apiKey: "stale", baseURL: "https://stale.example", headers: {
      AUTHORIZATION: "Bearer stale", "x-opper-project": "stale", "X-Team": "keep",
    } };
    const config = await run({ provider: { opper: { models: { pool: {
      options: { ...stale, textVerbosity: "low" },
      variants: { personal: { ...stale, reasoningEffort: "high", settings: stale } },
    } } } } });
    const { toOpenCodeModels, preserveOpenCodeVariants } = await import("../../src/setup/opencode-models.js");
    const expected = preserveOpenCodeVariants(toOpenCodeModels(data as any), { pool: {
      options: { ...stale, textVerbosity: "low" },
      variants: { personal: { ...stale, reasoningEffort: "high", settings: stale } },
    } });
    expect(config.provider.opper.models).toEqual(expected);
    expect(JSON.stringify(config)).not.toContain("stale");
    expect(config.provider.opper.models.pool.options).toEqual({ textVerbosity: "low", headers: { "X-Team": "keep" } });
    expect(config.provider.opper.models.pool.variants.personal.settings).toEqual({ headers: { "X-Team": "keep" } });
  });

  it("reads the selected CLI key and injects Opper only in memory", async () => {
    await slot({ apiKey: "synthetic-key", expiresAt: "2030-01-01T00:00:00Z" });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => catalog(["anthropic/claude-sonnet-5"]) });
    vi.stubGlobal("fetch", fetchMock);
    const config = await run({ provider: { other: { name: "Other" }, opper: { options: { apiKey: "old-key" } } } });

    expect(config.provider.other).toEqual({ name: "Other" });
    expect(config.provider.opper.options).toEqual({ baseURL: "https://api.opper.ai/v3/compat", apiKey: "synthetic-key" });
    expect(config.provider.opper.whitelist).toEqual(["anthropic/claude-sonnet-5"]);
    expect(config.provider.opper.models["anthropic/claude-sonnet-5"].cost).toEqual({ input: 1, output: 2 });
    expect(fetchMock).toHaveBeenCalledWith("https://api.opper.ai/v3/compat/models", expect.objectContaining({ headers: { Authorization: "Bearer synthetic-key" } }));
    expect(await readFile(join(home, ".opper", "config.json"), "utf8")).not.toContain("old-key");
  });

  it("uses an environment credential without borrowing the stored slot's scope or host", async () => {
    await slot({ apiKey: "finnova-key", baseUrl: "https://finnova.example", expiresAt: "2020-01-01", defaultProjectUuid: "11111111-1111-4111-8111-111111111111" });
    process.env.OPPER_API_KEY = "personal-env-key";
    process.env.OPPER_BASE_URL = "https://personal.example";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => catalog(["model/one"]) }));
    const config = await run({});
    expect(config.provider.opper.options).toEqual({ baseURL: "https://personal.example/v3/compat", apiKey: "personal-env-key" });
  });

  it("uses an explicit environment target for both discovery and inference settings", async () => {
    const projectUuid = "11111111-1111-4111-8111-111111111111";
    await slot({ apiKey: "org-key", orgId: 42, defaultProjectUuid: "22222222-2222-4222-8222-222222222222" });
    process.env.OPPER_PROJECT_UUID = projectUuid;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => catalog(["model/one"]) });
    vi.stubGlobal("fetch", fetchMock);
    const config = await run({ provider: { opper: { options: { headers: { "X-Opper-Project": "stale" } } } } });
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: { Authorization: "Bearer org-key", "X-Opper-Project": projectUuid } }));
    expect(config.provider.opper.options.headers).toEqual({ "X-Opper-Project": projectUuid });
    delete process.env.OPPER_PROJECT_UUID;
    expect((await run(config)).provider.opper.options.headers).toBeUndefined();
  });

  it("fails closed when an explicit target is malformed", async () => {
    await slot({ apiKey: "org-key", orgId: 42 });
    process.env.OPPER_PROJECT_UUID = "bad";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await run({ provider: { opper: {} } })).provider.opper).toBeUndefined();
  });

  it("preserves the session route supplied by opper launch opencode", async () => {
    await slot({ apiKey: "plain-key" });
    process.env.OPPER_CLI_LAUNCH_OPENCODE = "1";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const launchConfig = { provider: { opper: { options: { baseURL: "https://api.opper.ai/v3/session/example", apiKey: "launch-key" } } } };
    expect(await run(launchConfig)).toBe(launchConfig);
    expect(launchConfig.provider.opper.options.apiKey).toBe("launch-key");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("removes Opper in memory when the key is missing or expired", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const initial = { provider: { other: { name: "Other" }, opper: { options: { apiKey: "stale" } } }, model: "opper/stale" };
    const noKey = await run(structuredClone(initial));
    expect(noKey.provider.other).toEqual({ name: "Other" });
    expect(noKey.provider.opper).toBeUndefined();
    expect(noKey.model).toBeUndefined();

    await slot({ apiKey: "synthetic-key", expiresAt: "2020-01-01T00:00:00Z" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const expired = await run(structuredClone(initial));
    expect(expired.provider.opper).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed for Opper when the catalog cannot be fetched", async () => {
    await slot({ apiKey: "synthetic-key" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = await run({ provider: { other: {}, opper: { models: { stale: {} } } } });
    expect(config.provider.other).toEqual({});
    expect(config.provider.opper).toBeUndefined();
  });

  it("refreshes the allowed models on each startup and clears a stale Opper default", async () => {
    await slot({ apiKey: "synthetic-key" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => catalog(["model/one"]) })
      .mockResolvedValueOnce({ ok: true, json: async () => catalog(["model/two"]) });
    vi.stubGlobal("fetch", fetchMock);
    const first = await run({ model: "opper/model/one" });
    expect(first.provider.opper.whitelist).toEqual(["model/one"]);
    const second = await run({ model: "opper/model/one", small_model: "opper/model/one" });
    expect(second.provider.opper.whitelist).toEqual(["model/two"]);
    expect(second.model).toBeUndefined();
    expect(second.small_model).toBeUndefined();
  });

  it("reads the same OPPER_HOME override as the CLI", async () => {
    process.env.OPPER_HOME = join(home, "custom-operator-home");
    await mkdir(process.env.OPPER_HOME, { recursive: true });
    await writeFile(join(process.env.OPPER_HOME, "config.json"), JSON.stringify({
      version: 1, defaultKey: "default", keys: { default: { apiKey: "custom-home-key" } },
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => catalog(["model/one"]) }));
    expect((await run({})).provider.opper.options.apiKey).toBe("custom-home-key");
  });

  it("uses the CLI's literal default slot even when another slot was created first", async () => {
    const directory = join(home, ".opper");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "config.json"), JSON.stringify({
      version: 1, defaultKey: "staging", keys: {
        staging: { apiKey: "staging-key" },
        default: { apiKey: "production-key" },
      },
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => catalog(["model/one"]) }));
    expect((await run({})).provider.opper.options.apiKey).toBe("production-key");
    process.env.OPPER_KEY_SLOT = "staging";
    expect((await run({})).provider.opper.options.apiKey).toBe("staging-key");
  });
});
