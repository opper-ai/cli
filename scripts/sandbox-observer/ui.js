const token = location.hash.slice(1);
history.replaceState(null, "", "/");
const $ = (id) => document.getElementById(id);
let sessions = [],
  selected;
let navSignature = "";
let selectedHost;
let graphSignature = "";
function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
function resourceList(id, entries, empty) {
  const counts = new Map();
  for (const [text, kind] of entries) {
    const key = `${kind}\n${text}`;
    const previous = counts.get(key);
    counts.set(key, { text, kind, count: (previous?.count ?? 0) + 1 });
  }
  const list = $(id);
  list.replaceChildren();
  for (const { text, kind, count } of [...counts.values()].slice(0, 40)) {
    const item = el("li");
    item.append(
      el("span", text),
      el(
        "small",
        `${kind}${count > 1 ? ` ×${count}` : ""}`,
        kind === "blocked" ? "blocked" : "muted",
      ),
    );
    list.append(item);
  }
  if (!counts.size) list.append(el("li", empty, "muted"));
  if (counts.size > 40)
    list.append(
      el(
        "li",
        `${counts.size - 40} more resources in the event window`,
        "muted",
      ),
    );
}
function networkGraph(session) {
  const hosts = new Map();
  for (const event of session.events.filter((e) => e.kind === "NETWORK")) {
    const host = event.detail.replace(/ blocked$/, "");
    const current = hosts.get(host) ?? { host, count: 0, last: event.time };
    current.count++;
    current.last = event.time;
    hosts.set(host, current);
  }
  $("network-counts").replaceChildren(
    ...[
      [
        String([...hosts.values()].reduce((sum, host) => sum + host.count, 0)),
        "Blocked attempts",
        "blocked",
      ],
      [String(hosts.size), "Blocked destinations", "blocked"],
      [
        String(new Set(session.allowed).size),
        "Allowed-policy hosts",
        "permitted",
      ],
      ["Not captured", "Allowed connections", "muted"],
    ].map(([value, label, kind]) => {
      const node = el("div", undefined, kind);
      node.append(el("strong", value), el("span", label));
      return node;
    }),
  );
  const nodes = [...hosts.values()].sort((a, b) => b.count - a.count);
  if ($("graph-policy").checked) {
    for (const host of session.allowed) nodes.unshift({ host, count: 0 });
  }
  const visible = nodes.slice(0, 40);
  const signature = JSON.stringify([session.id, visible, selectedHost]);
  $("graph-summary").textContent =
    `${hosts.size} blocked destinations; ${[...hosts.values()].reduce((sum, h) => sum + h.count, 0)} attempts in the event window. Click a blocked host to filter the timeline.${nodes.length > 40 ? " Showing the first 40 destinations." : ""}`;
  $("clear-host").hidden = !selectedHost;
  if (signature === graphSignature) return;
  graphSignature = signature;
  const container = $("network-graph");
  container.replaceChildren();
  if (!visible.length) {
    container.append(
      el("p", "No blocked network attempts in this event window.", "muted"),
    );
    return;
  }
  const ns = "http://www.w3.org/2000/svg";
  const svg = (tag, attrs, text) => {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attrs))
      node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const height = Math.max(180, visible.length * 78 + 24),
    center = Math.min(height / 2, 130);
  const canvas = svg("svg", {
    viewBox: `0 0 760 ${height}`,
    width: 760,
    height,
    role: "group",
    "aria-label": `Network destinations for ${session.name}`,
  });
  for (const [i, host] of visible.entries()) {
    const y = 12 + i * 78;
    canvas.append(
      svg("path", {
        d: `M 205 ${center} C 280 ${center}, 280 ${y + 30}, 345 ${y + 30}`,
        class: host.count ? "graph-edge denied" : "graph-edge policy",
      }),
    );
    const group = svg("g", {
      class: `graph-host ${host.count ? "denied" : "policy"}${selectedHost === host.host && host.count ? " active" : ""}`,
      ...(host.count
        ? {
            role: "button",
            tabindex: 0,
            "aria-label": `${host.host}: ${host.count} blocked attempts. Filter timeline.`,
            "aria-pressed": String(selectedHost === host.host),
          }
        : {}),
    });
    group.append(
      svg(
        "title",
        {},
        host.count
          ? `${host.host} · last blocked ${new Date(host.last).toLocaleString()}`
          : `${host.host} · allowed by policy; connections not observed`,
      ),
    );
    group.append(svg("rect", { x: 345, y, width: 395, height: 60, rx: 7 }));
    group.append(
      svg(
        "text",
        { x: 360, y: y + 23, class: "graph-label" },
        host.host.length > 44 ? host.host.slice(0, 41) + "…" : host.host,
      ),
    );
    group.append(
      svg(
        "text",
        { x: 360, y: y + 44, class: "graph-caption" },
        host.count
          ? `${host.count} blocked ${host.count === 1 ? "attempt" : "attempts"}`
          : "Allowed by policy · traffic unobserved",
      ),
    );
    if (host.count) {
      const choose = () => {
        selectedHost = selectedHost === host.host ? undefined : host.host;
        $("filter").value = "NETWORK";
        render();
      };
      group.onclick = choose;
      group.onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          choose();
        }
      };
    }
    canvas.append(group);
  }
  canvas.append(
    svg("rect", {
      x: 10,
      y: center - 36,
      width: 195,
      height: 72,
      rx: 8,
      class: "graph-source",
    }),
  );
  canvas.append(
    svg("text", { x: 26, y: center - 6, class: "graph-label" }, session.name),
  );
  canvas.append(
    svg(
      "text",
      { x: 26, y: center + 17, class: "graph-caption" },
      "Sandbox session",
    ),
  );
  container.append(canvas);
}
function render() {
  const search = $("search").value.toLowerCase();
  const nav = $("sessions");

  const visible = sessions.filter((s) =>
    `${s.name} ${s.project}`.toLowerCase().includes(search),
  );
  const signature = JSON.stringify([
    selected,
    search,
    visible.map((s) => [s.id, s.name, s.project, s.state]),
  ]);
  if (signature !== navSignature) {
    navSignature = signature;
    nav.replaceChildren();
    for (const s of visible) {
      const button = el("button");
      button.className = s.id === selected ? "selected" : "";
      button.setAttribute("aria-pressed", String(s.id === selected));
      button.append(
        el("strong", s.name),
        el("span", s.project),
        el("small", s.state, s.state === "Live" ? "live" : "muted"),
      );
      button.onclick = () => {
        selected = s.id;
        selectedHost = undefined;
        render();
      };
      nav.append(button);
    }
    if (!visible.length)
      nav.append(
        el(
          "p",
          search ? "No matching sessions." : "No logs found yet.",
          "muted",
        ),
      );
  }
  const s = sessions.find((s) => s.id === selected);
  $("empty").hidden = !!s;
  $("detail").hidden = !s;
  if (!s) return;
  $("metadata").replaceChildren(
    ...[
      ["Harness", s.harness],
      ["Model", s.model],
      ["Sandbox", s.backend],
      [
        "Started",
        s.started ? new Date(s.started).toLocaleString() : "Unavailable",
      ],
      ["Monitor PID", s.monitorPid],
    ].map(([label, value]) => {
      const entry = el("div");
      entry.append(el("dt", label), el("dd", value));
      return entry;
    }),
  );
  $("name").textContent = s.name;
  $("source").textContent = s.name;
  $("project").textContent = s.project;
  $("sessionId").textContent = s.id;
  $("state").textContent =
    s.state === "Unknown" ? "Status unknown · no recent heartbeat" : s.state;
  $("state").className = "pill " + (s.state === "Live" ? "live" : "");
  resourceList(
    "network",
    [
      ...s.allowed.map((host) => [host, "allowed by policy"]),
      ...s.events
        .filter((e) => e.kind === "NETWORK")
        .map((e) => [e.detail.replace(/ blocked$/, ""), "blocked"]),
    ],
    "No network observations in this window.",
  );
  resourceList(
    "files",
    s.events
      .filter((e) => e.kind === "FILE")
      .map((e) => [
        e.detail.replace(/^(changed|created\/deleted\/renamed) /, ""),
        "change observed",
      ]),
    "No file changes in this window.",
  );
  resourceList(
    "tools",
    s.events
      .filter((e) => e.kind === "TOOL")
      .map((e) => [e.detail.split(" ")[0], "events reported"]),
    "No tool events in this window.",
  );
  networkGraph(s);
  const filter = $("filter").value;
  const events = s.events.filter(
    (e) =>
      (filter === "all" ||
        e.kind === filter ||
        (filter === "TOOL" && e.kind === "TOOLS")) &&
      (!selectedHost ||
        (e.kind === "NETWORK" &&
          e.detail.replace(/ blocked$/, "") === selectedHost)),
  );
  $("timeline").replaceChildren(
    ...events
      .slice()
      .reverse()
      .map((e) => {
        const row = el("tr");
        row.append(
          el("td", new Date(e.time).toLocaleTimeString()),
          el("td", e.kind, e.kind === "NETWORK" ? "blocked" : ""),
          el("td", e.detail),
        );
        return row;
      }),
  );
  $("window").textContent =
    `Latest ${s.events.length} events, newest first. ${s.clipped ? "Older log data is outside the 128 KiB window. " : ""}Resource counts cover this window only.`;
  $("coverage").replaceChildren(...s.coverage.map((text) => el("li", text)));
}
$("search").oninput = render;
$("filter").onchange = () => {
  selectedHost = undefined;
  render();
};
$("graph-policy").onchange = render;
$("clear-host").onclick = () => {
  selectedHost = undefined;
  render();
};
function showView(view) {
  for (const name of ["activity", "network"]) {
    $(`${name}-tab`).setAttribute("aria-selected", String(name === view));
    $(`${name}-tab`).tabIndex = name === view ? 0 : -1;
    $(`${name}-panel`).hidden = name !== view;
  }
  selectedHost = undefined;
  $("filter").value = view === "network" ? "NETWORK" : "all";
  render();
}
for (const view of ["activity", "network"]) {
  $(`${view}-tab`).onclick = () => showView(view);
  $(`${view}-tab`).onkeydown = (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === "Home"
          ? "activity"
          : event.key === "End"
            ? "network"
            : view === "network"
              ? "activity"
              : "network";
      showView(next);
      $(`${next}-tab`).focus();
    }
  };
}
$("activity-tab").tabIndex = -1;
$("filter").value = "NETWORK";
async function refresh() {
  try {
    const response = await fetch("/api/sessions", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "Open the full URL printed in the terminal to connect."
          : "Collector unavailable. Displayed data may be stale.",
      );
    const data = await response.json();
    sessions = data.sessions;
    sessions.sort(
      (a, b) =>
        (b.state === "Live") - (a.state === "Live") ||
        (b.updated ?? "").localeCompare(a.updated ?? ""),
    );
    if (!sessions.some((s) => s.id === selected)) selected = sessions[0]?.id;
    $("connection").textContent =
      `Local collector · updated ${new Date(data.generatedAt).toLocaleTimeString()}`;
    $("limit").textContent = data.omitted
      ? `${data.omitted} older sessions omitted; showing at most 64.`
      : "Up to 64 recent sessions. Refreshes every 2 seconds.";
    render();
  } catch (error) {
    $("connection").textContent = error.message;
  } finally {
    setTimeout(refresh, 2000);
  }
}
refresh();
