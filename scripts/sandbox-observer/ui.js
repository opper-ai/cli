const token = location.hash.slice(1);
history.replaceState(null, "", "/");
const $ = (id) => document.getElementById(id);

let sessions = [];
let policy;
let policyBusy = false;
let selected;
let view = "network";
let filter = "all";
let hostFilter;

function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
function svg(tag, attrs = {}, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs))
    node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
// Polling re-renders every second. Rebuilding only when the inputs
// change keeps focus, hover and scroll position where the reader left them.
const signatures = new WeakMap();
function sync(node, signature, build) {
  const key = JSON.stringify(signature);
  if (signatures.get(node) === key) return;
  signatures.set(node, key);
  node.replaceChildren(...build());
}

const plural = (n, word) =>
  `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const clock = (time) => new Date(time).toLocaleTimeString();
function span(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return plural(Math.floor(hours / 24), "day");
}
function ago(time) {
  const minutes = Math.floor((Date.now() - Date.parse(time)) / 60000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}
const shortPath = (path) => path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
// A NETWORK event is "<host>:<port> blocked", or "… allowed" in a session
// launched with --allow-all.
const netHost = (event) => event.detail.replace(/ (?:blocked|allowed)$/, "");
const wasAllowed = (event) => event.detail.endsWith(" allowed");
const isBlocked = (event) => event.kind === "NETWORK" && !wasAllowed(event);
// A REQUEST event is "<METHOD> <url without query>", from --log-urls.
function requestHost(event) {
  try {
    return new URL(event.detail.split(" ")[1]).hostname;
  } catch {
    return "";
  }
}
const allowsAll = (s) => (s.networkMode ?? "").includes("allow-all");
const logsUrls = (s) => (s.networkMode ?? "").includes("urls");
// Policy rules name a bare host; connections are logged as host:port.
const bare = (host) =>
  host.replace(/:(?:\d+|unknown)$/, "").replace(/^\[|\]$/g, "");
const command = (s) =>
  s.harness && s.harness !== "Unavailable" ? s.harness : s.name;
const launcher = (s) => (s.name.includes(" / ") ? s.name.split(" / ")[0] : "");
const hasProject = (s) => s.project.startsWith("/");
const blockedCount = (s) => s.events.filter(isBlocked).length;
const blockedTotal = (s) => s.totals?.blocked ?? blockedCount(s);

const GROUPS = {
  REQUEST: "request",
  FILE: "file",
  PROCESS: "process",
  TOOL: "tool",
  TOOLS: "tool",
};
const group = (event) =>
  event.kind === "NETWORK"
    ? wasAllowed(event)
      ? "allowed"
      : "network"
    : (GROUPS[event.kind] ?? "other");
const KIND_LABELS = {
  REQUEST: "Request",
  FILE: "File",
  PROCESS: "Program",
  TOOL: "Tool",
  TOOLS: "Tool",
  SESSION: "Session",
  EXIT: "Session",
  ERROR: "Error",
  POLICY: "Policy",
  COVERAGE: "Note",
};

function renderSessions() {
  const search = $("search").value.trim().toLowerCase();
  const visible = sessions.filter((s) =>
    `${s.name} ${s.harness} ${s.project}`.toLowerCase().includes(search),
  );
  sync(
    $("sessions"),
    [
      selected,
      search,
      Math.floor(Date.now() / 60000),
      visible.map((s) => [
        s.id,
        s.state,
        s.updated,
        s.archived,
        blockedTotal(s),
      ]),
    ],
    () => {
      if (!visible.length)
        return [
          el(
            "p",
            search ? "No session matches that search." : "Nothing here yet.",
            "fine",
          ),
        ];
      const nodes = [];
      for (const [title, members] of [
        ["Running", visible.filter((s) => s.state === "Live")],
        ["Ended", visible.filter((s) => s.state !== "Live" && !s.archived)],
        ["History", visible.filter((s) => s.archived)],
      ]) {
        if (!members.length) continue;
        nodes.push(el("h2", `${title} (${members.length})`));
        for (const s of members) {
          const button = el("button", undefined, s.state.toLowerCase());
          if (s.id === selected) button.classList.add("selected");
          button.setAttribute("aria-current", String(s.id === selected));
          const top = el("span", undefined, "row");
          top.append(
            el("i", undefined, "dot"),
            el("strong", command(s)),
            el(
              "small",
              s.state === "Live"
                ? "running"
                : s.state === "Unknown"
                  ? "no heartbeat"
                  : ago(s.updated),
            ),
          );
          const bottom = el("span", undefined, "row");
          const project = el(
            "span",
            hasProject(s)
              ? s.project.split("/").filter(Boolean).at(-1)
              : "project not recorded",
            "where",
          );
          project.title = s.project;
          bottom.append(project);
          const blocked = blockedTotal(s);
          if (blocked)
            bottom.append(el("small", `${blocked} blocked`, "blocked"));
          button.append(top, bottom);
          button.onclick = () => {
            selected = s.id;
            hostFilter = undefined;
            render();
          };
          nodes.push(button);
        }
      }
      return nodes;
    },
  );
}

function renderHeader(s) {
  $("name").textContent = command(s);
  $("state").textContent =
    s.state === "Live"
      ? "Running"
      : s.state === "Unknown"
        ? "No recent heartbeat"
        : "Ended";
  if (s.archived) $("state").textContent = "From history";
  $("state").className = `pill ${s.state.toLowerCase()}`;
  $("project").textContent = hasProject(s) ? shortPath(s.project) : s.project;
  $("project").title = s.project;
  sync(
    $("metadata"),
    [
      s.id,
      s.model,
      s.started,
      s.monitorPid,
      s.policyVersion,
      s.totals,
      s.networkMode,
    ],
    () =>
      [
        ["Sandbox", [launcher(s), s.backend].filter(Boolean).join(" on ")],
        [
          "Network",
          (allowsAll(s) ? "Open, every host logged" : "Allowlist") +
            (logsUrls(s) ? ", URLs logged" : ""),
        ],
        ["Model", s.model],
        [
          "Started",
          s.started ? new Date(s.started).toLocaleString() : "Unavailable",
        ],
        [
          "Network policy",
          s.policyVersion === null ? "Fixed at launch" : `v${s.policyVersion}`,
        ],
        ["Monitor PID", s.monitorPid],
        ["Log", s.id],
        ...(s.totals
          ? [
              [
                "Recorded in history",
                `${plural(s.totals.events, "event")}: ${s.totals.blocked.toLocaleString()} blocked, ${plural(s.totals.files, "file change")}, ${plural(s.totals.tools, "tool call")}`,
              ],
            ]
          : []),
      ].map(([label, value]) => {
        const entry = el("div");
        entry.append(el("dt", label), el("dd", value));
        return entry;
      }),
  );
}

// One bar per time slice across the event window: when things happened, and
// whether it was network traffic, file changes or tool calls. Requests are
// left out: each one already shows as a connection.
function renderRibbon(s) {
  const marks = s.events.filter(
    (e) => !["other", "request", "process"].includes(group(e)),
  );
  const first = Date.parse(s.events[0]?.time ?? s.started);
  const last =
    s.state === "Live"
      ? Date.now()
      : Date.parse(s.events.at(-1)?.time ?? s.started);
  const width = Math.max(last - first, 1000);
  $("ribbon-title").textContent = marks.length
    ? `${plural(marks.length, "event")} over ${span(width)}`
    : "No network traffic, file changes or tool calls recorded";
  $("ribbon-start").textContent = Number.isFinite(first) ? clock(first) : "";
  $("ribbon-end").textContent =
    s.state === "Live" ? "now" : Number.isFinite(last) ? clock(last) : "";
  sync($("ribbon"), [s.id, marks.length, Math.floor(last / 5000)], () => {
    const slices = 96,
      height = 48,
      slot = 1000 / slices;
    const buckets = Array.from({ length: slices }, () => ({
      network: 0,
      allowed: 0,
      file: 0,
      tool: 0,
    }));
    for (const event of marks) {
      const at = Math.floor(
        ((Date.parse(event.time) - first) / width) * slices,
      );
      buckets[Math.min(Math.max(at, 0), slices - 1)][group(event)]++;
    }
    const peak = Math.max(
      1,
      ...buckets.map((b) => b.network + b.allowed + b.file + b.tool),
    );
    const canvas = svg("svg", {
      viewBox: `0 0 760 ${height}`,
      preserveAspectRatio: "none",
      role: "img",
      "aria-label": $("ribbon-title").textContent,
    });
    canvas.append(
      svg("line", { x1: 0, x2: 1000, y1: height - 0.5, y2: height - 0.5 }),
    );
    for (const [i, bucket] of buckets.entries()) {
      let y = height - 1;
      const parts = [];
      for (const kind of ["tool", "file", "allowed", "network"]) {
        if (!bucket[kind]) continue;
        const size = Math.max(3, (bucket[kind] / peak) * (height - 4));
        y -= size;
        canvas.append(
          svg("rect", {
            x: i * slot + 1,
            y: Math.max(y, 0),
            width: slot - 2,
            height: size,
            class: kind,
          }),
        );
        parts.push(`${bucket[kind]} ${kind === "network" ? "blocked" : kind}`);
      }
      if (parts.length)
        canvas.lastChild.append(
          svg(
            "title",
            {},
            `${clock(first + (i / slices) * width)}: ${parts.reverse().join(", ")}`,
          ),
        );
    }
    return [canvas];
  });
}

function destinationRows(s) {
  const rows = new Map();
  const row = (host) => {
    if (!rows.has(host)) rows.set(host, { host, attempts: 0, passed: 0 });
    return rows.get(host);
  };
  if (s) {
    for (const host of s.allowed) row(host).allowed = true;
    for (const event of s.events.filter((e) => e.kind === "NETWORK")) {
      const entry = row(bare(netHost(event)));
      if (wasAllowed(event)) entry.passed++;
      else entry.attempts++;
      entry.last = event.time;
    }
  }
  for (const [host, action] of Object.entries(policy?.rules ?? {}))
    row(host).rule = action;
  const rank = (r) =>
    r.attempts
      ? 0
      : r.passed
        ? 1
        : r.rule === "deny"
          ? 2
          : r.rule === "allow"
            ? 3
            : 4;
  return [...rows.values()].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.attempts - a.attempts ||
      b.passed - a.passed ||
      a.host.localeCompare(b.host),
  );
}

function renderNetwork(s) {
  $("network-panel").hidden = !!s && view !== "network";
  $("network-title").hidden = !!s;
  $("network-note").textContent = !s
    ? "Rules below apply to every Dune session on this machine, including ones you start later."
    : allowsAll(s)
      ? `This session follows the machine policy: every host is reachable unless a rule denies it, and each connection is listed here.${logsUrls(s) ? " Request URLs are in the Activity tab." : ""} Deny a host to block it in every session from now on; connections already open stay open.`
      : s.policyVersion === null
        ? "This session’s network access was fixed at launch, so rule changes won’t reach it. Only blocked attempts are recorded; allowed connections are not."
        : "Only blocked attempts are recorded; allowed connections are not. Rule changes reach running Dune sessions within a few seconds.";
  const rows = destinationRows(s);
  const peak = Math.max(1, ...rows.map((r) => r.attempts + r.passed));
  sync($("destinations"), [s?.id, s?.policyVersion, rows, policyBusy], () => {
    if (!rows.length) {
      const cell = el(
        "td",
        s
          ? "No hosts allowed and no network traffic seen in this window."
          : "No rules yet, so sessions can reach every host. Deny one below, or from a session’s list of hosts.",
        "fine",
      );
      cell.colSpan = 5;
      const line = el("tr");
      line.append(cell);
      return [line];
    }
    return rows.map((r) => {
      const line = el("tr");
      const name = el("td");
      if ((r.attempts || r.passed) && s) {
        const jump = el("button", r.host, "link host");
        jump.title = "Show this host’s traffic in the activity timeline";
        jump.onclick = () => {
          hostFilter = r.host;
          filter = "all";
          showView("activity");
        };
        name.append(jump);
      } else name.append(el("code", r.host, "host"));

      const status = el("td");
      const [label, tone, hint] =
        r.rule === "deny"
          ? ["Denied by rule", "blocked", ""]
          : r.rule === "allow"
            ? [
                "Allowed by rule",
                "permitted",
                s && allowsAll(s)
                  ? "no effect here, only in --strict sessions"
                  : s && !r.allowed
                    ? s.policyVersion === null
                      ? "not followed by this session"
                      : s.state === "Live"
                        ? "not applied yet"
                        : ""
                    : "",
              ]
            : r.allowed
              ? ["Allowed at launch", "permitted", ""]
              : r.passed && !r.attempts
                ? ["Allowed", "permitted", "no rule denies it"]
                : s && allowsAll(s)
                  ? ["Blocked earlier", "blocked", "its deny rule was removed"]
                  : ["Blocked", "blocked", "not on the allowlist"];
      status.append(el("span", label, `tag ${tone}`));
      if (hint) status.append(el("small", hint));

      const attempts = el("td", undefined, "attempts");
      for (const [n, text, tone] of [
        [r.attempts, "blocked", "blocked"],
        [r.passed, r.passed === 1 ? "connection" : "connections", "permitted"],
      ]) {
        if (!n) continue;
        const line = el("div");
        const bar = el("i", undefined, `bar ${tone}`);
        bar.style.setProperty("--share", `${(n / peak) * 100}%`);
        line.append(el("span", `${n.toLocaleString()} ${text}`, tone), bar);
        attempts.append(line);
      }
      if (!r.attempts && !r.passed)
        attempts.append(el("span", s ? "none seen" : "", "fine"));

      const last = el("td", r.last ? ago(r.last) : "", "fine");
      if (r.last) last.title = new Date(r.last).toLocaleString();

      const actions = el("td", undefined, "actions");
      if (!/[*/\s]/.test(r.host)) {
        const offer = (text, action, cls) => {
          const button = el("button", text, cls);
          button.disabled = policyBusy;
          button.setAttribute("aria-label", `${text}: ${r.host}`);
          button.onclick = () => changeRule(r.host, action);
          actions.append(button);
        };
        const open = s && allowsAll(s) && !r.rule;
        if (
          r.rule !== "allow" &&
          !(r.allowed && !r.rule) &&
          !(s && allowsAll(s))
        )
          offer("Allow", "allow", "allow");
        if (r.rule !== "deny" && (r.allowed || r.rule || open))
          offer("Deny", "deny", "deny");
        if (r.rule) offer("Remove rule", "inherit", "quiet");
      }
      line.append(name, status, attempts, last, actions);
      return line;
    });
  });

  if (!policy) return;
  const live = sessions.filter((x) => x.state === "Live");
  const managed = live.filter((x) => x.policyVersion !== null);
  const current = managed.filter((x) => x.policyVersion === policy.version);
  $("policy-summary").textContent = !live.length
    ? `Policy v${policy.version}. No sessions are running; new launches start with these rules.`
    : `Policy v${policy.version}, applied by ${current.length} of ${plural(managed.length, "running Dune session")}.`;
  const lagging = live.filter((x) => x.policyVersion !== policy.version);
  sync(
    $("policy-agents"),
    lagging.map((x) => [x.id, x.policyVersion]),
    () =>
      lagging.map((x) =>
        el(
          "li",
          x.policyVersion === null
            ? `${command(x)} in ${shortPath(x.project)} doesn’t follow live rules. Relaunch it with dune to manage it here.`
            : `${command(x)} in ${shortPath(x.project)} is still on v${x.policyVersion}.`,
        ),
      ),
  );
}

function describe(event) {
  const cell = el("td");
  const code = (text) => el("code", text);
  if (event.kind === "NETWORK") {
    cell.append(
      code(netHost(event)),
      wasAllowed(event) ? " connection allowed" : " blocked",
    );
  } else if (event.kind === "REQUEST") {
    const [method, ...url] = event.detail.split(" ");
    cell.append(`${method} `, code(url.join(" ")));
  } else if (event.kind === "FILE") {
    const match = /^(changed|created\/deleted\/renamed) (.+)$/.exec(
      event.detail,
    );
    const refused = REFUSED.exec(event.detail);
    if (refused) {
      cell.append(
        code(shortPath(refused[2])),
        ` ${refused[1]} refused by the sandbox`,
      );
      cell.className = "blocked";
    } else if (!match) cell.append(event.detail);
    else
      cell.append(
        code(match[2]),
        match[1] === "changed" ? " changed" : " created, removed or renamed",
      );
  } else if (event.kind === "PROCESS") {
    const match = /^(.+) \(pid (\d+)\)$/.exec(event.detail);
    if (!match) cell.append(event.detail);
    else cell.append(code(shortPath(match[1])), ` ran as pid ${match[2]}`);
  } else if (event.kind === "TOOL") {
    const match = /^(\S+) (start|end|error)(?: · (\d+)ms observed)?$/.exec(
      event.detail,
    );
    if (!match) cell.append(event.detail);
    else {
      const took =
        Number(match[3]) > 0
          ? ` after ${Number(match[3]) < 1000 ? `${match[3]} ms` : `${(Number(match[3]) / 1000).toFixed(1)} s`}`
          : "";
      cell.append(
        code(match[1]),
        match[2] === "start"
          ? " started"
          : match[2] === "end"
            ? ` finished${took}`
            : ` failed${took}`,
      );
      if (match[2] === "error") cell.className = "blocked";
    }
  } else if (event.kind === "POLICY" && /^\d+$/.test(event.detail)) {
    cell.append(`Applied network policy v${event.detail}`);
  } else cell.append(event.detail);
  return cell;
}

const REFUSED = /^(read|write) blocked (.+)$/;

function tally(id, entries, empty, unit) {
  const counts = new Map();
  for (const key of entries) counts.set(key, (counts.get(key) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  sync($(id), ranked, () => {
    if (!ranked.length) return [el("li", empty, "fine")];
    const items = ranked.slice(0, 30).map(([text, n]) => {
      const item = el("li");
      const label = el("code", text);
      label.title = text;
      item.append(label, el("small", unit(n)));
      return item;
    });
    if (ranked.length > 30)
      items.push(el("li", `and ${ranked.length - 30} more`, "fine"));
    return items;
  });
}

function renderActivity(s) {
  $("activity-panel").hidden = view !== "activity";
  const totals = {
    all: s.events.length,
    network: 0,
    allowed: 0,
    request: 0,
    file: 0,
    process: 0,
    tool: 0,
    other: 0,
  };
  for (const event of s.events) totals[group(event)]++;
  sync($("filters"), [filter, totals], () =>
    [
      ["all", "Everything"],
      ["network", "Blocked network"],
      ...(totals.allowed ? [["allowed", "Allowed network"]] : []),
      ...(totals.request ? [["request", "Requests"]] : []),
      ["file", "Files"],
      ...(totals.process ? [["process", "Programs"]] : []),
      ["tool", "Tools"],
      ["other", "Session"],
    ].map(([value, label]) => {
      const chip = el("button", `${label} `);
      chip.append(el("span", String(totals[value]), "count"));
      chip.setAttribute("aria-pressed", String(filter === value));
      chip.onclick = () => {
        filter = value;
        render();
      };
      return chip;
    }),
  );
  $("host-filter").hidden = !hostFilter;
  $("host-filter-text").textContent = hostFilter
    ? `Only traffic to ${hostFilter}. `
    : "";
  const events = s.events.filter(
    (e) =>
      (filter === "all" || group(e) === filter) &&
      (!hostFilter ||
        (e.kind === "NETWORK" && bare(netHost(e)) === hostFilter) ||
        (e.kind === "REQUEST" && requestHost(e) === hostFilter)),
  );
  sync(
    $("timeline"),
    [s.id, filter, hostFilter, events.length, events.at(-1)?.time],
    () => {
      if (!events.length) {
        const cell = el("td", "Nothing of this kind in the window.", "fine");
        cell.colSpan = 3;
        const line = el("tr");
        line.append(cell);
        return [line];
      }
      return events
        .slice()
        .reverse()
        .map((e) => {
          const line = el("tr", undefined, group(e));
          const time = el("td", clock(e.time), "time");
          time.title = new Date(e.time).toLocaleString();
          const kind = el("td");
          kind.append(
            el(
              "span",
              e.kind === "NETWORK"
                ? wasAllowed(e)
                  ? "Allowed"
                  : "Blocked"
                : (KIND_LABELS[e.kind] ??
                    e.kind.charAt(0) + e.kind.slice(1).toLowerCase()),
              `tag ${isBlocked(e) || e.kind === "ERROR" || (e.kind === "FILE" && REFUSED.test(e.detail)) ? "blocked" : e.kind === "NETWORK" ? "permitted" : ""}`,
            ),
          );
          line.append(time, kind, describe(e));
          return line;
        });
    },
  );
  $("window").textContent =
    s.totals && s.totals.events > s.events.length
      ? `Newest first, latest ${s.events.length.toLocaleString()} of ${plural(s.totals.events, "recorded event")}. The ribbon and counts on this page cover these ${s.events.length.toLocaleString()}.`
      : `Newest first, latest ${plural(s.events.length, "event")}.` +
        (s.clipped
          ? " Older events have scrolled out of the 128 KiB window."
          : "");
  tally(
    "files",
    s.events
      .filter((e) => e.kind === "FILE" && !REFUSED.test(e.detail))
      .map((e) =>
        e.detail.replace(/^(changed|created\/deleted\/renamed) /, ""),
      ),
    "No file changes seen.",
    (n) => `${n}×`,
  );
  const requests = s.events.filter((e) => e.kind === "REQUEST");
  $("urls-box").hidden = !requests.length;
  tally(
    "urls",
    requests.map((e) => e.detail),
    "",
    (n) => `${n}×`,
  );
  const programs = s.events.filter((e) => e.kind === "PROCESS");
  $("programs-box").hidden = !programs.length;
  tally(
    "programs",
    programs.map((e) => shortPath(e.detail.replace(/ \(pid \d+\)$/, ""))),
    "",
    (n) => `${n}×`,
  );
  tally(
    "tools",
    s.events
      .filter((e) => e.kind === "TOOL" && / start$/.test(e.detail))
      .map((e) => e.detail.split(" ")[0]),
    "No tool calls reported.",
    (n) => plural(n, "call"),
  );
}

// Every running agent on the left, every destination any of them contacted on
// the right, and one line per agent, destination and outcome. Calls with the
// same outcome share a line that thickens with their number; drawing each
// call separately turns a busy session into a solid block.
const lastCalls = new Map();
function renderGraph() {
  $("graph-panel").hidden = view !== "graph";
  // The graph is about every agent, so the selected session's header steps
  // aside and the picture starts at the top of the page.
  $("detail").classList.toggle("overview", view === "graph");
  const running = sessions.filter((s) => s.state === "Live");
  const agents = (
    running.length ? running : sessions.filter((s) => !s.archived)
  ).slice(0, 24);
  const links = new Map();
  const hosts = new Map();
  agents.forEach((s, index) => {
    for (const event of s.events) {
      if (event.kind !== "NETWORK") continue;
      const host = bare(netHost(event));
      const ok = wasAllowed(event);
      const key = `${s.id} ${host} ${ok}`;
      const link = links.get(key) ?? { agent: index, host, ok, calls: 0 };
      link.calls++;
      links.set(key, link);
      const node = hosts.get(host) ?? { host, ok: 0, blocked: 0, pull: 0 };
      node[ok ? "ok" : "blocked"]++;
      node.pull += index;
      hosts.set(host, node);
    }
  });
  // Destinations sit near the agents that use them, so lines cross less.
  const ranked = [...hosts.values()].sort(
    (a, b) =>
      a.pull / (a.ok + a.blocked) - b.pull / (b.ok + b.blocked) ||
      a.host.localeCompare(b.host),
  );
  const shown = ranked.slice(0, 60);
  const place = new Map(shown.map((node, index) => [node.host, index]));
  const edges = [...links.entries()].filter(([, link]) =>
    place.has(link.host),
  );
  $("graph-count").textContent = agents.length ? String(agents.length) : "";
  $("graph-note").textContent = !agents.length
    ? "No agents yet."
    : `${running.length ? plural(agents.length, "running agent") : `No agent is running; showing ${plural(agents.length, "ended session")}`} and ${plural(shown.length, "destination")}${ranked.length > shown.length ? ` (${ranked.length - shown.length} quieter ones hidden)` : ""}. Lines update as calls happen.`;
  sync(
    $("graph"),
    [
      selected,
      agents.map((s) => [s.id, command(s), s.project, s.state]),
      edges.map(([key, link]) => [key, link.calls]),
    ],
    () => {
      if (!agents.length)
        return [el("p", "Start an agent with dune to see it here.", "fine")];
      const row = 46;
      const left = 200;
      const right = 470;
      const gap = (count) =>
        (Math.max(agents.length, shown.length) - count) * (row / 2);
      const agentY = (i) => 30 + gap(agents.length) + i * row;
      const hostY = (i) => 30 + gap(shown.length) + i * row;
      const height = 60 + (Math.max(agents.length, shown.length, 1) - 1) * row;
      const canvas = svg("svg", {
        viewBox: `0 0 760 ${height}`,
        role: "img",
        "aria-label": `${plural(agents.length, "agent")} and ${plural(shown.length, "destination")}; ${edges.filter(([, l]) => !l.ok).length} blocked routes`,
      });
      for (const [key, link] of edges) {
        const both = links.has(
          `${agents[link.agent].id} ${link.host} ${!link.ok}`,
        );
        const lift = both ? (link.ok ? -4 : 4) : 0;
        const y1 = agentY(link.agent) + lift;
        const y2 = hostY(place.get(link.host)) + lift;
        const path = svg("path", {
          d: `M ${left} ${y1} C ${left + 120} ${y1}, ${right - 120} ${y2}, ${right} ${y2}`,
          class: `edge ${link.ok ? "ok" : "blocked"}${link.calls > (lastCalls.get(key) ?? link.calls) ? " fresh" : ""}`,
          "stroke-width": Math.min(1.5 + 1.8 * Math.log2(link.calls), 14).toFixed(1),
        });
        path.append(
          svg(
            "title",
            {},
            `${command(agents[link.agent])} → ${link.host}: ${plural(link.calls, "call")} ${link.ok ? "went through" : "blocked"}`,
          ),
        );
        canvas.append(path);
      }
      agents.forEach((s, i) => {
        const node = svg("g", {
          class: `agent${s.id === selected ? " selected" : ""}${s.state === "Live" ? " live" : ""}`,
          tabindex: 0,
          role: "button",
        });
        node.append(
          svg("rect", {
            x: 20,
            y: agentY(i) - 17,
            width: left - 20,
            height: 34,
            rx: 8,
          }),
          svg("circle", { cx: 36, cy: agentY(i), r: 4, class: "dot" }),
          svg("text", { x: 48, y: agentY(i) - 1 }, clip(command(s), 24)),
          svg(
            "text",
            { x: 48, y: agentY(i) + 12, class: "sub" },
            hasProject(s) ? clip(s.project.split("/").at(-1), 30) : "",
          ),
        );
        node.onclick = () => {
          selected = s.id;
          render();
        };
        node.onkeydown = (event) => {
          if (event.key === "Enter" || event.key === " ") node.onclick();
        };
        canvas.append(node);
      });
      shown.forEach((host, i) => {
        const node = svg("g", {
          class: `host ${host.blocked ? (host.ok ? "mixed" : "blocked") : "ok"}`,
        });
        node.append(
          svg("circle", { cx: right, cy: hostY(i), r: 6 }),
          svg("text", { x: right + 14, y: hostY(i) - 1 }, clip(host.host, 38)),
          svg(
            "text",
            { x: right + 14, y: hostY(i) + 12, class: "sub" },
            [
              host.ok && `${host.ok} ok`,
              host.blocked && `${host.blocked} blocked`,
            ]
              .filter(Boolean)
              .join(" · "),
          ),
        );
        canvas.append(node);
      });
      return [canvas];
    },
  );
  lastCalls.clear();
  for (const [key, link] of edges) lastCalls.set(key, link.calls);
}
const clip = (text, length) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

function render() {
  renderSessions();
  const s = sessions.find((x) => x.id === selected);
  $("empty").hidden = !!s || sessions.length > 0;
  $("detail").hidden = !s;
  renderNetwork(s);
  sync($("coverage"), s?.coverage ?? [], () =>
    (s?.coverage ?? []).map((text) => el("li", text)),
  );
  if (!s) return;
  renderHeader(s);
  renderRibbon(s);
  const blocked = blockedCount(s);
  const reached = new Set(
    s.events
      .filter((e) => e.kind === "NETWORK" && wasAllowed(e))
      .map((e) => bare(netHost(e))),
  ).size;
  $("network-count").textContent = blocked
    ? `${blocked} blocked`
    : reached
      ? `${reached} ${reached === 1 ? "host" : "hosts"} reached`
      : "";
  $("network-count").className = `count ${blocked ? "blocked" : ""}`;
  $("activity-count").textContent = String(s.events.length);
  renderActivity(s);
  renderGraph();
}

const VIEWS = ["network", "activity", "graph"];
function showView(next) {
  view = next;
  for (const name of VIEWS) {
    $(`${name}-tab`).setAttribute("aria-selected", String(name === view));
    $(`${name}-tab`).tabIndex = name === view ? 0 : -1;
  }
  if (view === "network") hostFilter = undefined;
  render();
}
for (const name of VIEWS) {
  $(`${name}-tab`).onclick = () => showView(name);
  $(`${name}-tab`).onkeydown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const at = VIEWS.indexOf(name);
    const next =
      event.key === "Home"
        ? VIEWS[0]
        : event.key === "End"
          ? VIEWS.at(-1)
          : VIEWS[
              (at + (event.key === "ArrowRight" ? 1 : -1) + VIEWS.length) %
                VIEWS.length
            ];
    showView(next);
    $(`${next}-tab`).focus();
  };
}
$("search").oninput = render;
$("clear-host").onclick = () => {
  hostFilter = undefined;
  render();
};

const PAST = {
  allow: "Allowed",
  deny: "Denied",
  inherit: "Removed the rule for",
};
async function changeRule(host, action) {
  if (!policy || policyBusy) return;
  policyBusy = true;
  render();
  const result = $("policy-result");
  try {
    const response = await fetch("/api/policy", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ version: policy.version, host, action }),
    });
    if (!response.ok) throw new Error(await response.text());
    policy = await response.json();
    result.className = "result";
    result.textContent = `${PAST[action]} ${host}. Policy v${policy.version} is published; running sessions pick it up within a few seconds.`;
    return true;
  } catch (error) {
    result.className = "result blocked";
    result.textContent = error.message;
    return false;
  } finally {
    policyBusy = false;
    render();
  }
}
$("policy-form").onsubmit = async (event) => {
  event.preventDefault();
  const input = $("policy-host");
  if (await changeRule(input.value.trim(), event.submitter?.value ?? "deny"))
    input.value = "";
};

async function refresh() {
  const connection = $("connection");
  try {
    const response = await fetch("/api/sessions", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "Not connected. Open the full URL that dune observe printed."
          : "The collector isn’t answering. What you see may be stale.",
      );
    const data = await response.json();
    sessions = data.sessions;
    if (!policyBusy) policy = data.policy;
    sessions.sort(
      (a, b) =>
        (b.state === "Live") - (a.state === "Live") ||
        (b.updated ?? "").localeCompare(a.updated ?? ""),
    );
    if (!sessions.some((s) => s.id === selected)) selected = sessions[0]?.id;
    connection.className = "connection ok";
    connection.textContent = `Updated ${clock(data.generatedAt)}`;
    $("limit").textContent = data.omitted
      ? `Showing the 64 most recent sessions; ${data.omitted} older ones are hidden.`
      : "";
    render();
  } catch (error) {
    connection.className = "connection error";
    connection.textContent = error.message;
  } finally {
    setTimeout(refresh, 1000);
  }
}
refresh();
