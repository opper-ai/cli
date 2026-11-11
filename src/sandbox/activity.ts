import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  watch,
  writeSync,
  type FSWatcher,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ActivitySink = (kind: string, detail: string) => void;

// A host-owned log stays outside the writable sandbox directories. Hook events are
// agent-reported telemetry, not an authenticated security audit.
export function startActivity(
  project: string,
  events: string,
  secret: string | string[],
) {
  const directory = mkdtempSync(join(tmpdir(), "opper-activity-"));
  const path = join(directory, "activity.log");
  const fd = openSync(path, "wx", 0o600);
  let closed = false;
  let failed = false;
  let written = 0;
  const maxLogBytes = 8 * 1024 * 1024;
  const clean = (value: string) => {
    const secrets = (Array.isArray(secret) ? secret : [secret])
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    const redacted = secrets.reduce(
      (text, key) => text.replaceAll(key, "[redacted]"),
      value,
    );
    return redacted
      .replace(/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/g, " ")
      .slice(0, 2048);
  };
  const emit: ActivitySink = (kind, detail) => {
    if (closed || failed) return;
    try {
      const line = `${new Date().toISOString()}  ${clean(kind).padEnd(10)} ${clean(detail)}\n`;
      if (written + Buffer.byteLength(line) > maxLogBytes) {
        writeSync(
          fd,
          `${new Date().toISOString()}  COVERAGE   Activity log limit reached; further events omitted.\n`,
        );
        failed = true;
        process.stderr.write("Activity log stopped: 8 MiB limit reached.\n");
        return;
      }
      written += writeSync(fd, line);
    } catch {
      failed = true;
      process.stderr.write("Activity log stopped: could not write to disk.\n");
    }
  };
  process.stderr.write(
    `Activity log: ${path}\nWatch in another terminal: tail -f ${path}\n`,
  );
  emit(
    "COVERAGE",
    "File notifications may be coalesced and include external edits. File access the sandbox refuses is logged; successful reads are not. Programs are sampled from the process table, so short-lived ones can be missed, and their arguments are not logged. Tool hooks are agent-reported; arguments, outputs and file contents are omitted.",
  );
  let input: number;
  try {
    mkdirSync(events, { recursive: true, mode: 0o700 });
    const eventPath = join(events, "tools.jsonl");
    input = openSync(
      eventPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
      0o600,
    );
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  let offset = 0;
  let pending = "";
  let discarding = false;
  const starts = new Map<string, number>();
  const drain = () => {
    try {
      const size = fstatSync(input).size;
      if (size < offset) {
        offset = 0;
        pending = "";
        discarding = false;
        starts.clear();
        emit("COVERAGE", "Tool event stream was truncated.");
      }
      // Bound processing per tick; never load an agent-controlled file wholesale.
      const buffer = Buffer.alloc(Math.min(Math.max(size - offset, 0), 65536));
      const count = readSync(input, buffer, 0, buffer.length, offset);
      offset += count;
      pending += buffer.subarray(0, count).toString("utf8");
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (discarding || line.length > 65536) {
          discarding = false;
          continue;
        }
        try {
          const item = JSON.parse(line);
          if (
            !["start", "end", "error", "ready"].includes(item.phase) ||
            typeof item.tool !== "string" ||
            !/^[\w.:-]{1,128}$/.test(item.tool)
          )
            continue;
          const id = typeof item.id === "string" ? item.id.slice(0, 128) : "";
          const now =
            Number.isSafeInteger(item.time) && item.time >= 0
              ? item.time
              : undefined;
          if (item.phase === "ready") {
            emit("TOOLS", `${item.tool} hooks ready (agent-reported)`);
            continue;
          }
          let duration = "";
          if (item.phase === "start") {
            if (now !== undefined && starts.size < 10000) starts.set(id, now);
          } else {
            const start = starts.get(id);
            if (start !== undefined && now !== undefined && now >= start)
              duration = ` · ${now - start}ms agent-reported`;
            starts.delete(id);
          }
          emit("TOOL", `${item.tool} ${item.phase}${duration}`);
        } catch {
          /* Partial or malformed agent records are not trusted. */
        }
      }
      if (pending.length > 65536) {
        pending = "";
        discarding = true;
        emit("COVERAGE", "Oversized tool event discarded.");
      }
    } catch {
      emit("COVERAGE", "Tool event stream could not be read.");
    }
  };
  emit("PROJECT", project);
  emit("HEARTBEAT", "monitor alive");
  const heartbeat = setInterval(() => emit("HEARTBEAT", "monitor alive"), 5000);
  heartbeat.unref();
  const timer = setInterval(drain, 200);
  timer.unref();
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(project, { recursive: true }, (event, filename) => {
      if (filename)
        emit(
          "FILE",
          `${event === "rename" ? "created/deleted/renamed" : "changed"} ${filename}`,
        );
      else emit("FILE", "Project changed (path unavailable)");
    });
    watcher.on("error", () =>
      emit(
        "COVERAGE",
        "File watcher failed; further file events may be missing.",
      ),
    );
  } catch {
    emit("COVERAGE", "Recursive file watching unavailable on this system.");
  }
  return {
    path,
    emit,
    close() {
      if (closed) return;
      clearInterval(timer);
      clearInterval(heartbeat);
      watcher?.close();
      drain();
      if (fstatSync(input).size > offset || pending.length)
        emit(
          "COVERAGE",
          "Unread or incomplete tool events remain at shutdown.",
        );
      closeSync(input);
      emit("SESSION", "monitor stopped");
      closed = true;
      closeSync(fd);
    },
  };
}
