import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { configureContinue } from "../../src/setup/continue.js";
import { continueConfigPath } from "../../src/util/editor-paths.js";
import { OPPER_OPENAI_COMPAT_URL } from "../../src/api/compat.js";

describe("configureContinue", () => {
  let home: string;
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.OPPER_EDITOR_HOME;
    home = mkdtempSync(join(tmpdir(), "opper-continue-"));
    process.env.OPPER_EDITOR_HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (prev === undefined) delete process.env.OPPER_EDITOR_HOME;
    else process.env.OPPER_EDITOR_HOME = prev;
  });

  it("writes the template with apiKey injected into each model", async () => {
    const result = await configureContinue({
      location: "global",
      apiKey: "op_live_test",
    });
    expect(result.wrote).toBe(true);
    const content = readFileSync(continueConfigPath("global"), "utf8");
    const parsed = parse(content) as { models: Array<Record<string, unknown>> };
    expect(parsed.models.length).toBeGreaterThan(0);
    expect(parsed.models.every((m) => m.apiKey === "op_live_test")).toBe(true);
    expect(parsed.models.every((m) => m.apiBase === OPPER_OPENAI_COMPAT_URL)).toBe(true);
  });

  it("appends to existing non-Opper config", async () => {
    const target = continueConfigPath("global");
    mkdirSync(join(home, ".continue"), { recursive: true });
    writeFileSync(
      target,
      "models:\n  - name: local-llm\n    apiBase: http://localhost:1234\n",
      "utf8",
    );
    const result = await configureContinue({
      location: "global",
      apiKey: "op_live_x",
    });
    expect(result.wrote).toBe(true);
    const parsed = parse(readFileSync(target, "utf8")) as {
      models: Array<Record<string, unknown>>;
    };
    expect(parsed.models.some((m) => m.name === "local-llm")).toBe(true);
    expect(parsed.models.some((m) => m.apiBase === OPPER_OPENAI_COMPAT_URL)).toBe(true);
  });

  it("refuses to append duplicate Opper models unless overwrite=true", async () => {
    await configureContinue({ location: "global", apiKey: "op_live_1" });
    const result = await configureContinue({
      location: "global",
      apiKey: "op_live_2",
    });
    expect(result.wrote).toBe(false);
    expect(result.reason).toBe("exists");

    const forced = await configureContinue({
      location: "global",
      apiKey: "op_live_2",
      overwrite: true,
    });
    expect(forced.wrote).toBe(true);
    const parsed = parse(readFileSync(continueConfigPath("global"), "utf8")) as {
      models: Array<{ apiKey?: string; apiBase?: string }>;
    };
    const opperModels = parsed.models.filter(
      (m) => m.apiBase === OPPER_OPENAI_COMPAT_URL,
    );
    expect(opperModels.every((m) => m.apiKey === "op_live_2")).toBe(true);
  });
});
