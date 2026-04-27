import { copyFile, mkdir, rm, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { backupsDir } from "../auth/paths.js";

export interface SnapshotHandle {
  agent: string;
  backupPath: string;
  timestamp: string;
}

function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function takeSnapshot(
  agent: string,
  sourcePath: string,
): Promise<SnapshotHandle> {
  const dir = backupsDir();
  await mkdir(dir, { recursive: true });
  const ts = isoStamp();
  const ext = extname(sourcePath) || "";
  const backupPath = join(dir, `${agent}-${ts}${ext}`);
  await copyFile(sourcePath, backupPath);
  return { agent, backupPath, timestamp: new Date().toISOString() };
}

export async function restoreSnapshot(
  handle: SnapshotHandle,
  targetPath: string,
): Promise<void> {
  await copyFile(handle.backupPath, targetPath);
}

export async function rotateBackups(agent: string, keep: number): Promise<void> {
  const dir = backupsDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const mine = entries
    .filter((f) => f.startsWith(`${agent}-`))
    .sort();
  const stale = mine.slice(0, Math.max(0, mine.length - keep));
  for (const f of stale) {
    await rm(join(dir, f), { force: true });
  }
}
