import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
});
