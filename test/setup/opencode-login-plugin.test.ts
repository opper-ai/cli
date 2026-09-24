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
  process.env.OPPER_EDITOR_HOME = home;
  delete process.env.OPPER_API_KEY;
  delete process.env.OPPER_BASE_URL;
  delete process.env.OPPER_KEY_SLOT;
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
  await rm(home, { recursive: true, force: true });
});

describe("OpenCode login plugin", () => {
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
    const second = await run({ model: "opper/model/one" });
    expect(second.provider.opper.whitelist).toEqual(["model/two"]);
    expect(second.model).toBeUndefined();
  });
});
