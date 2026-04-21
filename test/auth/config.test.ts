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
