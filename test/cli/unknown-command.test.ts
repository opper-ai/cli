import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Runs the real entry point: the root command's default action is what used to
// answer an unknown command, and the exit code only exists at the process boundary.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SPAWN_TIMEOUT = 60_000;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

describe("opper with an unknown command", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "opper-unknown-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function run(args: string[]): Promise<Run> {
    return new Promise((done) => {
      const child = execFile(
        process.execPath,
        ["--import", "tsx", "src/index.ts", ...args],
        {
          cwd: ROOT,
          env: { ...process.env, OPPER_HOME: home, NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
        },
        (error, stdout, stderr) => done({
          code: typeof error?.code === "number" ? error.code : 0,
          stdout,
          stderr,
        }),
      );
      child.stdin?.end();
    });
  }

  it.each([
    [["functions", "list"], "functions"],
    [["functions", "delete", "my-function"], "functions"],
    [["--key", "work", "nonsense"], "nonsense"],
  ])("%j fails instead of printing help and exiting zero", async (args, name) => {
    const result = await run(args);

    expect(result.code).toBe(8);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Unknown command "${name}"`);
    expect(result.stderr).toContain("opper --help");
  }, SPAWN_TIMEOUT);

  it("still prints help with no command", async () => {
    const result = await run([]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: opper");
    expect(result.stderr).toBe("");
  }, SPAWN_TIMEOUT);

  it("still prints help with only global options", async () => {
    const result = await run(["--key", "work"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: opper");
  }, SPAWN_TIMEOUT);

  it("still prints help for `opper help`", async () => {
    const result = await run(["help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: opper");
    expect(result.stdout).toContain("Platform");
  }, SPAWN_TIMEOUT);

  it.each([[["help", "traces"]], [["traces", "--help"]]])("%j prints that command's help", async (args) => {
    const result = await run(args);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: opper traces");
  }, SPAWN_TIMEOUT);

  it("still runs a known command", async () => {
    const result = await run(["version"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  }, SPAWN_TIMEOUT);
});
