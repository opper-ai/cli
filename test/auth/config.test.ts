import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { readConfig } from "../../src/auth/config.js";

const home = useTempOpperHome();

describe("readConfig", () => {
  it("returns null when no config exists", async () => {
    const result = await readConfig();
    expect(result).toBeNull();
  });

  it("parses a valid config", async () => {
    mkdirSync(home.get(), { recursive: true });
    writeFileSync(
      join(home.get(), "config.json"),
      JSON.stringify({
        version: 1,
        defaultKey: "default",
        keys: {
          default: { apiKey: "op_live_abc" },
        },
      }),
      "utf8",
    );
    const result = await readConfig();
    expect(result?.version).toBe(1);
    expect(result?.defaultKey).toBe("default");
    expect(result?.keys.default?.apiKey).toBe("op_live_abc");
  });

  it("throws OpperError on malformed JSON", async () => {
    mkdirSync(home.get(), { recursive: true });
    writeFileSync(join(home.get(), "config.json"), "{not json", "utf8");
    await expect(readConfig()).rejects.toMatchObject({ code: "API_ERROR" });
  });
});

import { statSync, existsSync } from "node:fs";
import {
  writeConfig,
  getSlot,
  setSlot,
  deleteSlot,
} from "../../src/auth/config.js";

describe("writeConfig", () => {
  it("writes JSON with mode 0600", async () => {
    await writeConfig({
      version: 1,
      defaultKey: "default",
      keys: { default: { apiKey: "op_live_x" } },
    });
    const path = join(home.get(), "config.json");
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("creates OPPER_HOME if missing", async () => {
    await writeConfig({
      version: 1,
      defaultKey: "default",
      keys: {},
    });
    expect(existsSync(home.get())).toBe(true);
  });
});

describe("slot helpers", () => {
  it("setSlot creates a config if none exists and sets defaultKey", async () => {
    await setSlot("default", { apiKey: "op_live_1" });
    const slot = await getSlot();
    expect(slot?.apiKey).toBe("op_live_1");
  });

  it("setSlot does not overwrite defaultKey if one exists", async () => {
    await setSlot("default", { apiKey: "op_live_1" });
    await setSlot("staging", { apiKey: "op_live_2" });
    const cfg = await readConfig();
    expect(cfg?.defaultKey).toBe("default");
    expect(cfg?.keys.staging?.apiKey).toBe("op_live_2");
  });

  it("getSlot returns null when slot missing", async () => {
    expect(await getSlot("missing")).toBeNull();
  });

  it("getSlot with no name uses defaultKey", async () => {
    await setSlot("prod", { apiKey: "op_live_p" });
    // prod becomes default because no config existed
    expect((await getSlot())?.apiKey).toBe("op_live_p");
  });

  it("deleteSlot removes a slot", async () => {
    await setSlot("default", { apiKey: "op_live_1" });
    await setSlot("staging", { apiKey: "op_live_2" });
    await deleteSlot("staging");
    const cfg = await readConfig();
    expect(cfg?.keys.staging).toBeUndefined();
    expect(cfg?.keys.default).toBeDefined();
  });

  it("deleteSlot is a no-op when slot missing", async () => {
    await expect(deleteSlot("nonexistent")).resolves.not.toThrow();
  });
});
