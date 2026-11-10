import {
  readPolicy,
  changePolicy,
  policyDirectory,
  applyPolicy,
} from "../sandbox-policy/policy.mjs";
import { createServer } from "node:http";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { openStore } from "./store.mjs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

const windowBytes = 128 * 1024;
function records(text) {
  return text.split("\n").flatMap((line) => {
    const match = /^(\d{4}-\d\d-\d\dT\S+)  ([A-Z]+) +(.+)$/.exec(line);
    return match ? [{ time: match[1], kind: match[2], detail: match[3] }] : [];
  });
}
export function summarize(id, first, tail, clipped, now = Date.now()) {
  const header = records(first),
    events = records(tail);
  const latest = events.at(-1);
  let applied;
  const stopped = events.some(
    (e) =>
      e.kind === "EXIT" ||
      (e.kind === "SESSION" && e.detail === "monitor stopped"),
  );
  const heartbeat = events.findLast((e) => e.kind === "HEARTBEAT");
  const state = stopped
    ? "Stopped"
    : heartbeat && now - Date.parse(heartbeat.time) < 15000
      ? "Live"
      : "Unknown";
  return {
    id,
    policyVersion: (() => {
      const entry = [...header, ...events].findLast((e) => e.kind === "POLICY");
      return entry && /^\d+$/.test(entry.detail) ? Number(entry.detail) : null;
    })(),
    harness:
      header.find((e) => e.kind === "HARNESS")?.detail ??
      header
        .find((e) => e.kind === "SESSION")
        ?.detail.match(/^srt \/ (\w+) starting;/)?.[1] ??
      "Unavailable",
    model:
      header.find((e) => e.kind === "MODEL")?.detail ??
      "Unavailable in older logs",
    backend: header.find((e) => e.kind === "BACKEND")?.detail ?? "srt",
    monitorPid:
      header.find((e) => e.kind === "MONITOR")?.detail ?? "Unavailable",
    state,
    clipped,
    name:
      header.find((e) => e.kind === "SESSION")?.detail.split(" starting;")[0] ??
      "Sandbox session",
    project:
      header.find((e) => e.kind === "PROJECT")?.detail ??
      "Project unavailable in older logs",
    started: header[0]?.time,
    updated: latest?.time,
    allowed: header.filter((e) => e.kind === "ALLOW").map((e) => e.detail),
    coverage: [
      ...new Set(
        [...header, ...events]
          .filter((e) => e.kind === "COVERAGE")
          .map((e) => e.detail),
      ),
    ],
    // Dune re-acknowledges its policy version every second; only the changes
    // are worth a row, or they crowd real activity out of the window.
    events: events
      .filter((e) => {
        if (e.kind === "HEARTBEAT") return false;
        if (e.kind !== "POLICY" || !/^\d+$/.test(e.detail)) return true;
        const changed = applied !== undefined && applied !== e.detail;
        applied = e.detail;
        return changed;
      })
      .slice(-300),
  };
}
async function logDirectories(root) {
  const candidates = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^opper-activity-[\w-]+$/.test(entry.name))
      continue;
    try {
      const directory = await lstat(join(root, entry.name));
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        (process.getuid && directory.uid !== process.getuid())
      )
        continue;
      candidates.push({ name: entry.name, mtime: directory.mtimeMs });
    } catch {
      /* A session can disappear during collection. */
    }
  }
  return candidates.sort((a, b) => b.mtime - a.mtime);
}
const openLog = (root, name) =>
  open(
    join(root, name, "activity.log"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
const ownFile = (stat) =>
  stat.isFile() && (!process.getuid || stat.uid === process.getuid());
/**
 * Copy what is new in each log into the history. Reads are incremental and
 * bounded per pass, so a large backlog is caught up over a few refreshes.
 */
export async function archive(root, store) {
  for (const { name } of await logDirectories(root)) {
    let file;
    try {
      file = await openLog(root, name);
      const stat = await file.stat();
      if (!ownFile(stat)) continue;
      let offset = store.offset(name);
      if (stat.size < offset) {
        store.reset(name);
        offset = 0;
      }
      if (stat.size === offset) continue;
      const buffer = Buffer.alloc(Math.min(stat.size - offset, 1048576));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      const end = buffer.subarray(0, bytesRead).lastIndexOf(10) + 1;
      if (!end) continue;
      store.append(
        name,
        records(buffer.subarray(0, end).toString("utf8")),
        offset + end,
      );
    } catch {
      /* A log can vanish mid-read; the next pass picks up where this left off. */
    } finally {
      await file?.close();
    }
  }
}
export async function scan(root = tmpdir()) {
  const candidates = await logDirectories(root);
  const sessions = [];
  for (const candidate of candidates.slice(0, 64)) {
    let file;
    try {
      file = await openLog(root, candidate.name);
      const stat = await file.stat();
      if (!ownFile(stat)) continue;
      const start = Math.max(0, stat.size - windowBytes);
      const head = Buffer.alloc(Math.min(stat.size, 16384));
      const tail = Buffer.alloc(Math.min(stat.size, windowBytes));
      const h = await file.read(head, 0, head.length, 0);
      const t = await file.read(tail, 0, tail.length, start);
      let text = tail.subarray(0, t.bytesRead).toString("utf8");
      if (start) text = text.slice(text.indexOf("\n") + 1);
      text = text.slice(0, text.lastIndexOf("\n") + 1);
      sessions.push(
        summarize(
          candidate.name,
          head.subarray(0, h.bytesRead).toString("utf8"),
          text,
          start > 0,
        ),
      );
    } catch {
      /* Missing, unreadable and symlink logs are omitted. */
    } finally {
      await file?.close();
    }
  }
  return {
    sessions,
    omitted: Math.max(0, candidates.length - 64),
    generatedAt: new Date().toISOString(),
  };
}
export async function startObserver({
  root = tmpdir(),
  port = 0,
  policyRoot = policyDirectory(),
  historyPath = join(dirname(policyRoot), "observer.db"),
} = {}) {
  // History is a convenience: the dashboard still works from logs alone.
  const store = await openStore(historyPath).catch(() => null);
  const token = randomBytes(32).toString("hex");
  const assets = new Map(
    await Promise.all(
      [
        ["/", "ui.html", "text/html"],
        ["/ui.js", "ui.js", "text/javascript"],
        ["/ui.css", "ui.css", "text/css"],
      ].map(async ([path, file, type]) => [
        path,
        { body: await readFile(new URL(file, import.meta.url)), type },
      ]),
    ),
  );
  let snapshot;
  let expires = 0;
  let inFlight;
  const server = createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    if (
      !["GET", "POST"].includes(req.method) ||
      req.headers.host !== origin.slice(7) ||
      (req.headers.origin && req.headers.origin !== origin)
    ) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    if (req.url === "/api/sessions" || req.url === "/api/policy") {
      const supplied = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        res.writeHead(401).end("Unauthorized");
        return;
      }
      if (req.url === "/api/policy") {
        try {
          let policy;
          if (req.method === "POST") {
            if (
              req.headers.origin !== origin ||
              req.headers["content-type"] !== "application/json"
            ) {
              res.writeHead(403).end("Forbidden");
              return;
            }
            let body = "";
            for await (const chunk of req) {
              body += chunk;
              if (body.length > 4096) {
                res.writeHead(413).end("Request too large");
                return;
              }
            }
            const input = JSON.parse(body);
            policy = changePolicy(
              input.version,
              input.host,
              input.action,
              policyRoot,
            );
          } else policy = readPolicy(policyRoot);
          res
            .writeHead(200, { "Content-Type": "application/json" })
            .end(JSON.stringify(policy));
        } catch {
          res
            .writeHead(409)
            .end(
              "Policy update failed. Refresh and check the hostname, version, and policy storage.",
            );
        }
        return;
      }
      if (req.method !== "GET") {
        res.writeHead(405).end("Method not allowed");
        return;
      }
      try {
        if (!snapshot || Date.now() > expires) {
          inFlight ??= scan(root)
            .then(async (value) => {
              if (store) {
                try {
                  await archive(root, store);
                  for (const session of value.sessions)
                    session.totals = store.totals(session.id);
                  value.sessions.push(
                    ...store.history(value.sessions.map((s) => s.id)),
                  );
                } catch {
                  /* Serve the live view even if the history is unwritable. */
                }
              }
              snapshot = value;
              expires = Date.now() + 1500;
            })
            .finally(() => {
              inFlight = undefined;
            });
          await inFlight;
        }
        const policy = readPolicy(policyRoot);
        const sessions = snapshot.sessions.map((session) => ({
          ...session,
          allowed:
            session.policyVersion === policy.version
              ? applyPolicy(
                  { allowedDomains: session.allowed, deniedDomains: [] },
                  policy,
                ).allowedDomains
              : session.allowed,
        }));
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ ...snapshot, policy, sessions }));
      } catch {
        res.writeHead(503).end("Could not read session logs");
      }
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405).end("Method not allowed");
      return;
    }
    const asset = assets.get(req.url);
    if (!asset) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": asset.type }).end(asset.body);
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", done);
  });
  server.once("close", () => store?.close());
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}/#${token}`,
    history: store?.path,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { server, url, history } = await startObserver();
  console.log(
    `Sandbox observer: ${url}\n${history ? `History: ${history}\n` : ""}Local policy and observability POC. Stop with Ctrl+C.`,
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => server.close());
}
