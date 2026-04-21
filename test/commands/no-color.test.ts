import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bin = resolve(here, "..", "..", "dist", "index.js");

describe("--no-color", () => {
  afterEach(() => {
    delete process.env.NO_COLOR;
  });

  it("suppresses ANSI codes in output when passed globally", () => {
    const out = execSync(
      `node "${bin}" --no-color whoami 2>&1 || true`,
      { encoding: "utf8", env: { ...process.env, OPPER_HOME: "/nonexistent" } },
    );
    // No ANSI escape at all in the output.
    expect(out).not.toMatch(/\x1b\[/);
    // But the error text is still there.
    expect(out).toContain("AUTH_REQUIRED");
  });
});
