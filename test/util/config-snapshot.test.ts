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
import { withJsonKey } from "../../src/util/config-snapshot.js";

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("withJsonKey", () => {
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

    await withJsonKey(path, ["providers", "opper"], async () => {
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

    await withJsonKey(path, ["providers", "opper"], async () => {
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

    await withJsonKey(path, ["providers", "opper"], async () => {
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

    await withJsonKey(path, ["providers", "opper"], async () => {
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

    await withJsonKey(path, ["providers", "opper"], async () => {
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
      withJsonKey(path, ["providers", "opper"], async () => {
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

    await withJsonKey(path, ["providers", "opper"], async () => {
      writeFileSync(
        path,
        JSON.stringify({ providers: { opper: { baseUrl: "session" } } }),
        "utf8",
      );
      chmodSync(path, 0o644);
    });

    expect(statSync(path).mode & 0o777).toBe(0o600);
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

    await withJsonKey(path, ["providers", "opper"], async () => {
      rmSync(dir, { recursive: true, force: true });
    });

    expect(readJson(path)).toEqual({
      providers: { opper: { baseUrl: "keep" } },
    });
  });
});
