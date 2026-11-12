import { execFile } from "node:child_process";
import type { ActivitySink } from "./activity.js";

/** One `ps` row: `pid ppid pgid command`. The command may contain spaces. */
export function parseProcesses(output: string) {
  const rows: { pid: number; parent: number; group: number; name: string }[] =
    [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match)
      rows.push({
        pid: Number(match[1]),
        parent: Number(match[2]),
        group: Number(match[3]),
        name: match[4]!.trim(),
      });
  }
  return rows;
}

/**
 * Logs each program that runs under the sandboxed command. Tracing every exec
 * needs root on macOS, so this samples the process table instead: a program
 * that starts and exits between two samples is missed. Only the executable is
 * logged, never its arguments, which often carry secrets.
 */
export function watchProcesses(
  root: number,
  emit: ActivitySink,
  interval = 250,
): () => void {
  const family = new Set([root]);
  const seen = new Set<string>();
  const pids = new Set<number>();
  let busy = false;
  let full = false;
  const sample = () => {
    if (busy || full) return;
    busy = true;
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,pgid=,comm="],
      { maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        busy = false;
        if (error) return;
        const rows = parseProcesses(stdout);
        // Forget pids that are gone so a reused number is not mistaken.
        const alive = new Set(rows.map((row) => row.pid));
        for (const pid of family) if (!alive.has(pid)) family.delete(pid);
        family.add(root);
        // The sandbox runs as one process group; children that leave it are
        // still found through their parent.
        for (let grew = true; grew; ) {
          grew = false;
          for (const row of rows)
            if (
              !family.has(row.pid) &&
              (row.group === root || family.has(row.parent))
            ) {
              family.add(row.pid);
              grew = true;
            }
        }
        for (const row of rows) {
          if (row.pid === root || !family.has(row.pid)) continue;
          // ps shows a program that is exiting as `(name)`; that is news
          // only when the sample never caught it running.
          const exiting = /^\((.+)\)$/.exec(row.name);
          if (exiting && pids.has(row.pid)) continue;
          const name = exiting ? exiting[1]! : row.name;
          // The same pid shows up again when it execs another program.
          const key = `${row.pid} ${name}`;
          if (seen.has(key)) continue;
          pids.add(row.pid);
          if (seen.size >= 5000) {
            full = true;
            emit(
              "COVERAGE",
              "Process log limit reached; further programs omitted.",
            );
            return;
          }
          seen.add(key);
          emit("PROCESS", `${name} (pid ${row.pid})`);
        }
      },
    );
  };
  const timer = setInterval(sample, interval);
  timer.unref();
  sample();
  return () => clearInterval(timer);
}
