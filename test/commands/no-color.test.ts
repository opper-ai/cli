import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bin = resolve(here, "..", "..", "dist", "index.js");
const built = existsSync(bin);

describe.skipIf(!built)("--no-color (built binary)", () => {
  afterEach(() => {
    delete process.env.NO_COLOR;
  });

  it("suppresses ANSI codes in output when passed globally", () => {
    const result = spawnSync(
      process.execPath, [bin, "--no-color", "whoami"],
      { encoding: "utf8", env: { ...process.env, OPPER_HOME: "/nonexistent", OPPER_API_KEY: "" } },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    const out = result.stdout + result.stderr;
    // No ANSI escape at all in the output.
    expect(out).not.toMatch(/\x1b\[/);
    // But the error text is still there.
    expect(out).toContain("AUTH_REQUIRED");
  });
});
