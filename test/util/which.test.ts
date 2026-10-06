import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { which } from "../../src/util/which.js";

describe("which", () => {
  it("returns a path for a binary that exists (node)", async () => {
    const path = await which("node");
    expect(path).not.toBeNull();
    expect(path).toMatch(/[/\\]node(?:\.exe)?$/i);
  });

  it("returns null for a nonexistent binary", async () => {
    const path = await which("this-binary-definitely-does-not-exist-xyz123");
    expect(path).toBeNull();
  });

  it.runIf(process.platform === "win32")("ignores a checkout executable even when PATH contains the working directory", async () => {
    const name = `opper-hostile-cwd-${randomUUID()}`;
    const file = join(process.cwd(), `${name}.cmd`);
    writeFileSync(file, "@echo off\r\nexit /b 0\r\n");
    vi.stubEnv("PATH", `${process.cwd()};.;${process.env.PATH ?? ""}`);
    try {
      expect(await which(name)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      rmSync(file, { force: true });
    }
  });
});
