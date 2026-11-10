import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// A small SQLite history for the observer. Activity logs live in the OS
// temporary directory and the dashboard only reads their last 128 KiB, so
// without this a session's story ends when its log is cleaned up or grows
// past the window. Uses Node's built-in driver: no dependency to install.

const KEEP_DAYS = 30;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT, harness TEXT, model TEXT, backend TEXT, project TEXT,
  monitor_pid TEXT, started TEXT, updated TEXT,
  stopped INTEGER NOT NULL DEFAULT 0,
  policy_version TEXT,
  allowed TEXT NOT NULL DEFAULT '[]',
  read_offset INTEGER NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0,
  tools INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  time TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
`;
const HEADER = {
  PROJECT: "project",
  HARNESS: "harness",
  MODEL: "model",
  BACKEND: "backend",
  MONITOR: "monitor_pid",
};

/** Opens the history, or returns null where this Node has no SQLite. */
export async function openStore(path) {
  let DatabaseSync;
  const warn = process.emitWarning;
  try {
    // The driver announces itself as experimental on every start.
    process.emitWarning = (message, ...rest) =>
      String(message).includes("SQLite")
        ? undefined
        : warn.call(process, message, ...rest);
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null;
  } finally {
    process.emitWarning = warn;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  // Paths and hostnames are in here; keep it to the owner like the logs.
  chmodSync(path, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  db.prepare("DELETE FROM sessions WHERE updated < ?").run(
    new Date(Date.now() - KEEP_DAYS * 86400000).toISOString(),
  );

  const find = db.prepare("SELECT * FROM sessions WHERE id = ?");
  const create = db.prepare("INSERT INTO sessions (id) VALUES (?)");
  const save = db.prepare(`UPDATE sessions SET
    name = ?, harness = ?, model = ?, backend = ?, project = ?,
    monitor_pid = ?, started = ?, updated = ?, stopped = ?,
    policy_version = ?, allowed = ?, read_offset = ?,
    events = ?, blocked = ?, files = ?, tools = ? WHERE id = ?`);
  const insert = db.prepare(
    "INSERT INTO events (session_id, seq, time, kind, detail) VALUES (?, ?, ?, ?, ?)",
  );
  const clear = db.prepare("DELETE FROM sessions WHERE id = ?");
  const latest = db.prepare(
    "SELECT time, kind, detail FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT ?",
  );
  const notes = db.prepare(
    "SELECT DISTINCT detail FROM events WHERE session_id = ? AND kind = 'COVERAGE'",
  );
  const recent = db.prepare(
    "SELECT * FROM sessions ORDER BY updated DESC LIMIT ?",
  );

  const totals = (row) => ({
    events: row.events,
    blocked: row.blocked,
    files: row.files,
    tools: row.tools,
  });

  return {
    path,
    /** Byte offset already stored for a log, so callers read only what is new. */
    offset: (id) => find.get(id)?.read_offset ?? 0,
    /** Forget a session whose log was truncated or replaced. */
    reset: (id) => void clear.run(id),
    /** Store newly read records and remember how far the log was read. */
    append(id, records, offset) {
      db.exec("BEGIN");
      try {
        if (!find.get(id)) create.run(id);
        const row = find.get(id);
        const allowed = JSON.parse(row.allowed);
        for (const { time, kind, detail } of records) {
          row.started ??= time;
          row.updated = time;
          if (kind === "HEARTBEAT") continue;
          if (kind in HEADER) {
            // Kept as session columns rather than timeline rows.
            row[HEADER[kind]] ??= detail;
            continue;
          } else if (kind === "ALLOW") {
            if (!allowed.includes(detail) && allowed.length < 256)
              allowed.push(detail);
            continue;
          } else if (kind === "SESSION" && detail.includes(" starting;")) {
            row.name ??= detail.split(" starting;")[0];
            row.harness ??= /^srt \/ (\w+)$/.exec(row.name)?.[1];
          } else if (kind === "POLICY" && /^\d+$/.test(detail)) {
            // Acknowledged every second; only a change is an event.
            const first = row.policy_version === null;
            const same = row.policy_version === detail;
            row.policy_version = detail;
            if (first || same) continue;
          }
          if (
            kind === "EXIT" ||
            (kind === "SESSION" && detail === "monitor stopped")
          )
            row.stopped = 1;
          if (kind === "NETWORK") row.blocked++;
          else if (kind === "FILE") row.files++;
          else if (kind === "TOOL" && detail.endsWith(" start")) row.tools++;
          insert.run(id, row.events++, time, kind, detail);
        }
        save.run(
          row.name,
          row.harness,
          row.model,
          row.backend,
          row.project,
          row.monitor_pid,
          row.started,
          row.updated,
          row.stopped,
          row.policy_version,
          JSON.stringify(allowed),
          offset,
          row.events,
          row.blocked,
          row.files,
          row.tools,
          id,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    /** Whole-session counts, where the dashboard otherwise sees a window. */
    totals(id) {
      const row = find.get(id);
      return row ? totals(row) : undefined;
    },
    /** Stored sessions whose logs are no longer being read, newest first. */
    history(liveIds, limit = 100) {
      const skip = new Set(liveIds);
      return recent
        .all(limit + skip.size)
        .filter((row) => !skip.has(row.id))
        .slice(0, limit)
        .map((row) => ({
          id: row.id,
          archived: true,
          // A log that vanished without an exit line ended some other way.
          state: row.stopped ? "Stopped" : "Unknown",
          policyVersion:
            row.policy_version === null ? null : Number(row.policy_version),
          harness: row.harness ?? "Unavailable",
          model: row.model ?? "Unavailable in older logs",
          backend: row.backend ?? "srt",
          monitorPid: row.monitor_pid ?? "Unavailable",
          clipped: row.events > 300,
          name: row.name ?? "Sandbox session",
          project: row.project ?? "Project unavailable in older logs",
          started: row.started,
          updated: row.updated,
          allowed: JSON.parse(row.allowed),
          coverage: notes.all(row.id).map((note) => note.detail),
          events: latest.all(row.id, 300).reverse(),
          totals: totals(row),
        }));
    },
    close: () => db.close(),
  };
}
