import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../../data/pi-opper-extension/opper-session.js";

describe("Pi launch extension", () => {
  let sandbox: string;
  const models = [{ id: "fixture-model", name: "Fixture", contextWindow: 128000, maxTokens: 8192 }];

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "opper-pi-extension-"));
    const catalog = join(sandbox, "catalog.json");
    writeFileSync(catalog, JSON.stringify(models));
    vi.stubEnv("OPPER_PI_CATALOG_PATH", catalog);
    vi.stubEnv("OPPER_API_KEY", "synthetic-fixture-key");
    vi.stubEnv("OPPER_BASE_URL", "http://127.0.0.1:1/v3/session/fixture");
    vi.stubEnv("OPPER_PROJECT_UUID", "fixture-project");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(sandbox, { recursive: true, force: true });
  });

  function host() {
    const handlers = new Map<string, (...args: any[]) => void>();
    const registerProvider = vi.fn();
    extension({ on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler), registerProvider });
    return { handlers, registerProvider };
  }

  it("registers the full catalog before startup model selection", () => {
    const { registerProvider } = host();
    expect(registerProvider).toHaveBeenCalledWith("opper", {
      api: "openai-completions", authHeader: true,
      apiKey: "synthetic-fixture-key", baseUrl: "http://127.0.0.1:1/v3/session/fixture",
      models, headers: { "X-Opper-Project": "fixture-project" },
    });
  });

  it("keeps routing and catalog on each session boundary with distinct trace IDs", () => {
    const { handlers, registerProvider } = host();
    const start = (file: string) => handlers.get("session_start")!({}, { sessionManager: { getSessionFile: () => file } });
    start("session-one.jsonl");
    const first = registerProvider.mock.calls.at(-1)![1];
    start("session-two.jsonl");
    const second = registerProvider.mock.calls.at(-1)![1];
    start("session-one.jsonl");
    const resumed = registerProvider.mock.calls.at(-1)![1];
    for (const value of [first, second, resumed]) {
      expect(value).toMatchObject({ api: "openai-completions", authHeader: true, models,
        apiKey: "synthetic-fixture-key", baseUrl: "http://127.0.0.1:1/v3/session/fixture" });
      expect(value.headers["X-Opper-Project"]).toBe("fixture-project");
      expect(value.headers["X-Opper-Trace-Id"]).toMatch(/^[a-f0-9-]{36}$/);
      expect(value.headers["X-Opper-Parent-Span-Id"]).toBe(value.headers["X-Opper-Trace-Id"]);
    }
    expect(first.headers["X-Opper-Trace-Id"]).not.toBe(second.headers["X-Opper-Trace-Id"]);
    expect(resumed.headers["X-Opper-Trace-Id"]).toBe(first.headers["X-Opper-Trace-Id"]);
  });

  it.each(["OPPER_API_KEY", "OPPER_BASE_URL", "OPPER_PI_CATALOG_PATH"])("does nothing outside a complete launch environment (%s absent)", (name) => {
    vi.stubEnv(name, "");
    expect(host().registerProvider).not.toHaveBeenCalled();
  });

  it.each(["{broken", "{}", "[]"])("rejects a damaged launch catalog: %s", (contents) => {
    writeFileSync(join(sandbox, "catalog.json"), contents);
    expect(() => host()).toThrow();
  });
});
