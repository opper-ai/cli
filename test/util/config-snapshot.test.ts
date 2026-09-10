import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { withJsonKeys } from "../../src/util/config-snapshot.js";

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("withJsonKeys", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "opper-snap-"));
  });
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("restores the captured value at the keyPath when it pre-existed", async () => {
    const path = join(sandbox, "models.json");
    writeFileSync(
      path,
      JSON.stringify({ providers: { opper: { baseUrl: "compat" } } }, null, 2),
      "utf8",
    );

    await withJsonKeys(path, [["providers", "opper"]], async () => {
      writeFileSync(
        path,
        JSON.stringify(
          { providers: { opper: { baseUrl: "session-url" } } },
          null,
          2,
        ),
        "utf8",
      );
    });

    expect(readJson(path)).toEqual({
      providers: { opper: { baseUrl: "compat" } },
    });
  });

  it("removes the key (and its now-empty parent) when it didn't exist before fn added it", async () => {
    const path = join(sandbox, "models.json");
    writeFileSync(path, JSON.stringify({ other: "stuff" }, null, 2), "utf8");

    await withJsonKeys(path, [["providers", "opper"]], async () => {
      writeFileSync(
        path,
        JSON.stringify(
          { other: "stuff", providers: { opper: { baseUrl: "x" } } },
          null,
          2,
        ),
        "utf8",
      );
    });

    expect(readJson(path)).toEqual({ other: "stuff" });
  });

  it("preserves sibling edits made during fn (the headline regression test)", async () => {
    // The launched agent (or a concurrent user edit) writes to a
    // sibling key — we must not clobber that on restore.
    const path = join(sandbox, "models.json");
    writeFileSync(
      path,
      JSON.stringify(
        { providers: { opper: { baseUrl: "compat" } }, theme: "dark" },
        null,
        2,
      ),
      "utf8",
    );

    await withJsonKeys(path, [["providers", "opper"]], async () => {
      const cur = readJson(path);
      // Agent rewrites our key (session URL) AND mutates a sibling.
      (cur.providers as Record<string, unknown>).opper = {
        baseUrl: "session-url",
      };
      (cur.providers as Record<string, unknown>).ollama = {
        baseUrl: "http://localhost:11434",
      };
      cur.theme = "light";
      writeFileSync(path, JSON.stringify(cur, null, 2), "utf8");
    });

    const after = readJson(path);
    expect(after.theme).toBe("light");
    expect((after.providers as Record<string, unknown>).ollama).toEqual({
      baseUrl: "http://localhost:11434",
    });
    expect((after.providers as Record<string, unknown>).opper).toEqual({
      baseUrl: "compat",
    });
  });

  it("deletes the file when it didn't exist before and is structurally empty after restore", async () => {
    const path = join(sandbox, "models.json");
    expect(existsSync(path)).toBe(false);

    await withJsonKeys(path, [["providers", "opper"]], async () => {
      writeFileSync(
        path,
        JSON.stringify({ providers: { opper: { baseUrl: "x" } } }, null, 2),
        "utf8",
      );
    });

    expect(existsSync(path)).toBe(false);
  });

  it("keeps the file when it didn't exist before but the agent added other content", async () => {
    const path = join(sandbox, "models.json");

    await withJsonKeys(path, [["providers", "opper"]], async () => {
      writeFileSync(
        path,
        JSON.stringify(
          {
            providers: {
              opper: { baseUrl: "x" },
              ollama: { baseUrl: "y" },
            },
          },
          null,
          2,
        ),
        "utf8",
      );
    });

    expect(readJson(path)).toEqual({
      providers: { ollama: { baseUrl: "y" } },
    });
  });

  it("restores even when fn throws, and rethrows the error", async () => {
    const path = join(sandbox, "models.json");
    writeFileSync(
      path,
      JSON.stringify({ providers: { opper: { baseUrl: "compat" } } }, null, 2),
      "utf8",
    );

    await expect(
      withJsonKeys(path, [["providers", "opper"]], async () => {
        writeFileSync(
          path,
          JSON.stringify(
            { providers: { opper: { baseUrl: "session" } } },
            null,
            2,
          ),
          "utf8",
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(readJson(path)).toEqual({
      providers: { opper: { baseUrl: "compat" } },
    });
  });

  it("preserves the original file mode", async () => {
    const path = join(sandbox, "secret.json");
    writeFileSync(
      path,
      JSON.stringify({ providers: { opper: { baseUrl: "compat" } } }),
      { mode: 0o600 },
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);

    await withJsonKeys(path, [["providers", "opper"]], async () => {
      writeFileSync(
        path,
        JSON.stringify({ providers: { opper: { baseUrl: "session" } } }),
        "utf8",
      );
      chmodSync(path, 0o644);
    });

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("restores multiple keyPaths independently", async () => {
    // OpenCode case: snapshot both `provider.opper` (the Opper provider
    // block) and the top-level `model` key — both are Opper-owned.
    const path = join(sandbox, "opencode.json");
    writeFileSync(
      path,
      JSON.stringify({
        provider: { opper: { baseURL: "compat" } },
        model: "opper/old-default",
        theme: "dark",
      }, null, 2),
      "utf8",
    );

    await withJsonKeys(
      path,
      [["provider", "opper"], ["model"]],
      async () => {
        writeFileSync(
          path,
          JSON.stringify({
            provider: { opper: { baseURL: "session-url" } },
            model: "opper/something-else",
            theme: "light", // sibling user edit, must survive
          }, null, 2),
          "utf8",
        );
      },
    );

    const after = readJson(path);
    expect(after.provider).toEqual({ opper: { baseURL: "compat" } });
    expect(after.model).toBe("opper/old-default");
    expect(after.theme).toBe("light");
  });

  it("removes multiple keyPaths if they didn't exist before fn added them", async () => {
    const path = join(sandbox, "opencode.json");
    writeFileSync(path, JSON.stringify({ theme: "dark" }, null, 2), "utf8");

    await withJsonKeys(
      path,
      [["provider", "opper"], ["model"]],
      async () => {
        writeFileSync(
          path,
          JSON.stringify({
            theme: "dark",
            provider: { opper: { baseURL: "x" } },
            model: "opper/y",
          }, null, 2),
          "utf8",
        );
      },
    );

    expect(readJson(path)).toEqual({ theme: "dark" });
  });

  it("works when the parent directory has to be recreated to restore", async () => {
    const dir = join(sandbox, "nested", "deep");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "models.json");
    writeFileSync(
      path,
      JSON.stringify({ providers: { opper: { baseUrl: "keep" } } }),
      "utf8",
    );

    await withJsonKeys(path, [["providers", "opper"]], async () => {
      rmSync(dir, { recursive: true, force: true });
    });

    expect(readJson(path)).toEqual({
      providers: { opper: { baseUrl: "keep" } },
    });
  });

  it("restores JSONC values while preserving unrelated comments and runtime edits", async () => {
    const path = join(sandbox, "opencode.json");
    writeFileSync(path, `{
  // Keep the user's provider preferences
  "provider": {
    "opper": { "options": { "baseURL": "compat" } },
    // Other provider annotation
    "other": { "enabled": true },
  },
  "theme": "dark", // Keep this preference comment
}\n`);

    await withJsonKeys(path, [["provider", "opper"]], async () => {
      const during = readFileSync(path, "utf8")
        .replace('"compat"', '"session-url"')
        .replace('"dark"', '"light"')
        .replace('"enabled": true', '"enabled": false');
      writeFileSync(path, during);
    });

    const restored = readFileSync(path, "utf8");
    expect(parse(restored)).toEqual({
      provider: { opper: { options: { baseURL: "compat" } }, other: { enabled: false } },
      theme: "light",
    });
    expect(restored).toContain("// Keep the user's provider preferences");
    expect(restored).toContain("// Other provider annotation");
    expect(restored).toContain('"theme": "light", // Keep this preference comment');
  });

  it("prunes newly added JSONC keys without rewriting unrelated comments", async () => {
    const path = join(sandbox, "opencode.json");
    writeFileSync(path, '{\n  // Keep the theme\n  "theme": "dark",\n}\n');
    await withJsonKeys(path, [["provider", "opper"], ["model"]], async () => {
      writeFileSync(path, `{
  "provider": { "opper": { "baseURL": "session" } },
  "model": "opper/test",
  // Keep the theme
  "theme": "light", // Added during the session
}\n`);
    });

    const restored = readFileSync(path, "utf8");
    expect(parse(restored)).toEqual({ theme: "light" });
    expect(restored).toContain("// Keep the theme");
    expect(restored).toContain("// Added during the session");
  });

  it("leaves unchanged JSONC bytes intact, including comments within captured values", async () => {
    const path = join(sandbox, "opencode.json");
    const original = '{\n\t"provider": {"opper": {/* User choice */ "model": "custom",}},\n}\n';
    writeFileSync(path, original);
    await withJsonKeys(path, [["provider", "opper"]], async () => {});
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("preserves a pre-existing empty parent and its comments", async () => {
    const path = join(sandbox, "opencode.json");
    writeFileSync(path, '{"provider":{/* Keep my provider container */}}');
    await withJsonKeys(path, [["provider", "opper"]], async () => {
      writeFileSync(path, '{"provider":{/* Keep my provider container */ "opper":{"baseURL":"session"}}}');
    });
    const restored = readFileSync(path, "utf8");
    expect(parse(restored)).toEqual({ provider: {} });
    expect(restored).toContain("/* Keep my provider container */");
  });

  it.each(["{broken", "[]", "null"])("does not run or overwrite an invalid configuration: %s", async (original) => {
    const path = join(sandbox, "opencode.json");
    writeFileSync(path, original);
    const run = vi.fn(async () => {});
    await expect(withJsonKeys(path, [["provider", "opper"]], run)).rejects.toMatchObject({ code: "AGENT_CONFIG_CONFLICT" });
    expect(run).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("preserves malformed runtime edits and the original callback error", async () => {
    const path = join(sandbox, "opencode.json");
    writeFileSync(path, '{"provider":{"opper":{"baseURL":"compat"}}}');
    const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await expect(withJsonKeys(path, [["provider", "opper"]], async () => {
        writeFileSync(path, "{unfinished runtime edit");
        throw new Error("launch failed");
      })).rejects.toThrow("launch failed");
      expect(readFileSync(path, "utf8")).toBe("{unfinished runtime edit");
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("failed to restore"));
    } finally {
      warning.mockRestore();
    }
  });
});
