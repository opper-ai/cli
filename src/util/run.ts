import { spawnSync, type SpawnSyncOptions } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command with a fixed argv, no shell. Returns a structured result so
 * callers decide what to do with non-zero exits. Use `inherit: true` when you
 * want the child's stdout/stderr to go to the CLI's own streams (for
 * interactive installers).
 */
export function run(
  command: string,
  args: string[],
  options: { inherit?: boolean } & Pick<SpawnSyncOptions, "cwd" | "env" | "shell"> = {},
): RunResult {
  const { inherit, ...rest } = options;
  const result = spawnSync(command, args, {
    ...rest,
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.error) {
    return { code: -1, stdout: "", stderr: result.error.message };
  }
  return {
    code: result.status ?? -1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}
