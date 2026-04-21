import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { maybeMigrateLegacyConfig } from "../../src/auth/migrate.js";
import { readConfig } from "../../src/auth/config.js";

const home = useTempOpperHome();

describe("maybeMigrateLegacyConfig", () => {
  it("does nothing when neither file exists", async () => {
    const migrated = await maybeMigrateLegacyConfig("/nonexistent/path");
    expect(migrated).toBe(false);
  });

  it("migrates a valid legacy file to the new schema", async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "opper-legacy-"));
    const legacyPath = join(legacyDir, ".oppercli");
    try {
      writeFileSync(
        legacyPath,
        [
          "api_keys:",
          "  default:",
          "    key: op_live_legacy",
          "    baseUrl: https://custom.example",
          "  staging:",
          "    key: op_live_stg",
        ].join("\n"),
        "utf8",
      );
      const migrated = await maybeMigrateLegacyConfig(legacyPath);
      expect(migrated).toBe(true);
      const cfg = await readConfig();
      expect(cfg?.defaultKey).toBe("default");
      expect(cfg?.keys.default?.apiKey).toBe("op_live_legacy");
      expect(cfg?.keys.default?.baseUrl).toBe("https://custom.example");
      expect(cfg?.keys.default?.source).toBe("migrated");
      expect(cfg?.keys.staging?.apiKey).toBe("op_live_stg");
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("skips migration when new config already exists", async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "opper-legacy-"));
    const legacyPath = join(legacyDir, ".oppercli");
    try {
      // pre-create a new-format config
      const { writeConfig } = await import("../../src/auth/config.js");
      await writeConfig({
        version: 1,
        defaultKey: "default",
        keys: { default: { apiKey: "op_live_new" } },
      });
      writeFileSync(legacyPath, "api_keys:\n  default:\n    key: op_live_old\n", "utf8");
      const migrated = await maybeMigrateLegacyConfig(legacyPath);
      expect(migrated).toBe(false);
      const cfg = await readConfig();
      expect(cfg?.keys.default?.apiKey).toBe("op_live_new");
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});
