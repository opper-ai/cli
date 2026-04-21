import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeSnapshot, restoreSnapshot, rotateBackups } from "../../src/util/backup.js";
import { useTempOpperHome } from "../helpers/temp-home.js";

const home = useTempOpperHome();

describe("backup", () => {
  let sourceDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "opper-backup-src-"));
  });
  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it("takeSnapshot copies the source file into ~/.opper/backups/", async () => {
    const src = join(sourceDir, "config.yaml");
    writeFileSync(src, "hello: world\n", "utf8");
    const handle = await takeSnapshot("hermes", src);
    expect(handle.agent).toBe("hermes");
    expect(handle.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(existsSync(handle.backupPath)).toBe(true);
    expect(readFileSync(handle.backupPath, "utf8")).toBe("hello: world\n");
  });

  it("restoreSnapshot copies the backup back to a target path", async () => {
    const src = join(sourceDir, "config.yaml");
    writeFileSync(src, "original\n", "utf8");
    const handle = await takeSnapshot("hermes", src);
    writeFileSync(src, "mutated\n", "utf8");
    await restoreSnapshot(handle, src);
    expect(readFileSync(src, "utf8")).toBe("original\n");
  });

  it("rotateBackups keeps only the N most-recent snapshots per agent", async () => {
    const src = join(sourceDir, "config.yaml");
    writeFileSync(src, "x\n", "utf8");
    for (let i = 0; i < 5; i++) {
      await takeSnapshot("hermes", src);
      await new Promise((r) => setTimeout(r, 10));
    }
    await rotateBackups("hermes", 2);
    const backups = readdirSync(join(home.get(), "backups")).filter(
      (f) => f.startsWith("hermes-"),
    );
    expect(backups).toHaveLength(2);
  });

  it("rotateBackups ignores other agents' backups", async () => {
    const src = join(sourceDir, "config.yaml");
    writeFileSync(src, "x\n", "utf8");
    await takeSnapshot("hermes", src);
    await takeSnapshot("pi", src);
    await takeSnapshot("pi", src);
    await rotateBackups("pi", 1);
    const all = readdirSync(join(home.get(), "backups"));
    expect(all.filter((f) => f.startsWith("hermes-"))).toHaveLength(1);
    expect(all.filter((f) => f.startsWith("pi-"))).toHaveLength(1);
  });
});
