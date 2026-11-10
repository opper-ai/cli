const token = location.hash.slice(1);
history.replaceState(null, "", "/");
const $ = (id) => document.getElementById(id);
let sessions = [],
  selected;
let navSignature = "";
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
  const filter = $("filter").value;
  const events = s.events.filter(
    (e) =>
      filter === "all" ||
      e.kind === filter ||
      (filter === "TOOL" && e.kind === "TOOLS"),
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
$("filter").onchange = render;
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
