import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync as nativeSpawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "../../src/util/spawn.js";

describe("cross-platform process execution", () => {
  let sandbox: string;
  beforeEach(() => { sandbox = mkdtempSync(join(tmpdir(), "opper spawn ")); });
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }); });

  it("preserves native executable argv, cwd, environment and exit code", () => {
    const args = ["", "a prompt with spaces", 'a "quote"', "a&b|c>file", "%OPPER_ARG_EXPANSION%", "caret^", "åäö", "C:\\path with spaces\\"];
    const result = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),env:process.env.OPPER_ARG_EXPANSION}));process.exit(17)", ...args], {
      cwd: sandbox, env: { ...process.env, OPPER_ARG_EXPANSION: "must remain literal" }, encoding: "utf8", timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(17);
    expect(JSON.parse(result.stdout)).toEqual({ args, cwd: realpathSync(sandbox), env: "must remain literal" });
  });

  it.runIf(process.platform === "win32")("reproduces native .cmd failure and launches the shim with literal arguments", () => {
    const bin = join(sandbox, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    const script = join(sandbox, "fixture.cjs");
    writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));process.exit(17)");
    const shim = join(bin, "fixture.cmd");
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    // Direct Node spawning cannot execute Windows npm shims, even with an
    // explicit extension. This is the failure the shared launcher fixes.
    expect(nativeSpawnSync(shim, [], { timeout: 10_000 }).error).toBeDefined();
    const args = ["", "a prompt with spaces", 'a "quote"', "a&b|c>file", "%OPPER_ARG_EXPANSION%", "caret^", "åäö", "C:\\path with spaces\\"];
    const result = spawnSync("fixture", args, {
      cwd: sandbox, env: { ...process.env, PATH: `${bin};${process.env.PATH ?? ""}`, OPPER_ARG_EXPANSION: "must remain literal" },
      encoding: "utf8", timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(17);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it("reports a missing executable", () => {
    const result = spawnSync("opper-missing-executable-945ad49d", [], { encoding: "utf8", timeout: 10_000 });
    expect(result.error?.code).toBe("ENOENT");
  });
});
