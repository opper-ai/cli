import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseArgs, assertPortableDependencies } from "../../scripts/build-bundles.mjs";

test("defaults include Windows x64 and arm64 and allow selecting either", () => {
  assert.deepEqual(parseArgs([]).targets, ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64", "windows-arm64"]);
  assert.deepEqual(parseArgs(["--target", "windows-arm64"]).targets, ["windows-arm64"]);
});

test("invalid or missing options fail before creating output", () => {
  for (const args of [["--out"], ["--target"], ["--out", "--target", "linux-x64"], ["--target", "wrong"], ["--wrong"]]) {
    assert.throws(() => parseArgs(args));
  }
});

test("shared dependency staging rejects native or platform-specific production packages", () => {
  const modules = mkdtempSync(join(tmpdir(), "opper bundle test "));
  try {
    const pure = { packages: { "node_modules/pure": {} } };
    assert.doesNotThrow(() => assertPortableDependencies(pure, modules));
    for (const metadata of [{ os: ["linux"] }, { cpu: ["x64"] }, { hasInstallScript: true }]) {
      assert.throws(() => assertPortableDependencies({ packages: { "node_modules/native": metadata } }, modules), /platform|install script/);
      assert.doesNotThrow(() => assertPortableDependencies({ packages: { "node_modules/dev": { ...metadata, dev: true } } }, modules));
    }
    mkdirSync(join(modules, "native"));
    writeFileSync(join(modules, "native", "binding.node"), "fixture");
    assert.throws(() => assertPortableDependencies(pure, modules), /native addon/);
  } finally {
    rmSync(modules, { recursive: true, force: true });
  }
});
