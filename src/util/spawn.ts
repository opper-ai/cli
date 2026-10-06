import { spawnSync as nativeSpawnSync } from "node:child_process";
import crossSpawn from "cross-spawn";

// Windows npm bins are .cmd shims. Resolve them and escape each argument
// before invoking cmd.exe; shell: true alone would interpret user prompts.
// Keep the native process path on POSIX, including its signal semantics.
export const spawnSync: typeof nativeSpawnSync = process.platform === "win32"
  ? crossSpawn.sync
  : nativeSpawnSync;
