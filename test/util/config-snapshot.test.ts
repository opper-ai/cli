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
import { withConfigSnapshot } from "../../src/util/config-snapshot.js";

describe("withConfigSnapshot", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "opper-snap-"));
  });
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("restores the original bytes when the file pre-existed", async () => {
    const path = join(sandbox, "config.toml");
    writeFileSync(path, "original\n", "utf8");

    const result = await withConfigSnapshot(path, async () => {
      writeFileSync(path, "mutated\n", "utf8");
      return 42;
    });

    expect(result).toBe(42);
    expect(readFileSync(path, "utf8")).toBe("original\n");
  });

  it("removes the file if it did not exist before", async () => {
    const path = join(sandbox, "models.json");
    expect(existsSync(path)).toBe(false);

    await withConfigSnapshot(path, async () => {
      writeFileSync(path, "{}\n", "utf8");
      expect(existsSync(path)).toBe(true);
    });

    expect(existsSync(path)).toBe(false);
  });

  it("restores even when fn throws, and rethrows the error", async () => {
    const path = join(sandbox, "config.toml");
    writeFileSync(path, "before\n", "utf8");

    await expect(
      withConfigSnapshot(path, async () => {
        writeFileSync(path, "during\n", "utf8");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(readFileSync(path, "utf8")).toBe("before\n");
  });

  it("removes a created file even when fn throws", async () => {
    const path = join(sandbox, "models.json");

    await expect(
      withConfigSnapshot(path, async () => {
        writeFileSync(path, "{}\n", "utf8");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(existsSync(path)).toBe(false);
  });

  it("preserves the original file mode", async () => {
    const path = join(sandbox, "secret.json");
    writeFileSync(path, "{}\n", { mode: 0o600 });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    await withConfigSnapshot(path, async () => {
      // Use chmodSync to actually loosen the mode — `writeFileSync`'s
      // `mode` option is silently ignored when the file already exists.
      writeFileSync(path, '{"x":1}\n', "utf8");
      chmodSync(path, 0o644);
      expect(statSync(path).mode & 0o777).toBe(0o644);
    });

    expect(readFileSync(path, "utf8")).toBe("{}\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("works when the parent directory has to be recreated to restore", async () => {
    // Simulates an adapter that nukes the directory mid-launch. Restore
    // should still put the original bytes back at the original path.
    const dir = join(sandbox, "nested", "deep");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "config.toml");
    writeFileSync(path, "keep me\n", "utf8");

    await withConfigSnapshot(path, async () => {
      rmSync(dir, { recursive: true, force: true });
    });

    expect(readFileSync(path, "utf8")).toBe("keep me\n");
  });
});
