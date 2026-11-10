import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archive,
  scan,
  startObserver,
  summarize,
} from "../../scripts/sandbox-observer/server.mjs";
import { openStore } from "../../scripts/sandbox-observer/store.mjs";
const time = new Date().toISOString();
const log = `${time}  PROJECT    /project\n${time}  SESSION    srt / pi starting; project edits are live\n${time}  HARNESS    pi\n${time}  MODEL      test-model\n${time}  BACKEND    srt\n${time}  MONITOR    123\n${time}  ALLOW      api.opper.ai\n${time}  HEARTBEAT  monitor alive\n${time}  NETWORK    example.com:443 blocked\n${time}  FILE       changed <img src=x onerror=alert(1)>\n`;
test("maps policy, observations and heartbeat without interpreting content", () => {
  const s = summarize("one", log, log, false);
  assert.equal(s.state, "Live");
  assert.equal(s.name, "srt / pi");
  assert.equal(s.harness, "pi");
  assert.equal(s.model, "test-model");
  assert.equal(s.monitorPid, "123");
  assert.deepEqual(s.allowed, ["api.opper.ai"]);
  assert.equal(s.events.at(-1).detail, "changed <img src=x onerror=alert(1)>");
  assert.equal(
    summarize("one", log, log, false, Date.now() + 30000).state,
    "Unknown",
  );
  assert.equal(
    summarize("one", log, log + `${time}  SESSION    monitor stopped\n`, false)
      .state,
    "Stopped",
  );
});
test("collector ignores symlinks, bounds reads and requires a local token", async () => {
  const root = await mkdtemp(join(tmpdir(), "observer-test-"));
  let server;
  try {
    const good = join(root, "opper-activity-good");
    await mkdir(good);
    await writeFile(join(good, "activity.log"), log);
    if (process.platform !== "win32") {
      const bad = join(root, "opper-activity-link");
      await mkdir(bad);
      await symlink(join(good, "activity.log"), join(bad, "activity.log"));
    }
    assert.equal((await scan(root)).sessions.length, 1);
    const observer = await startObserver({
      root,
      policyRoot: join(root, "policy"),
    });
    server = observer.server;
    const url = new URL(observer.url),
      token = url.hash.slice(1);
    const api = `${url.origin}/api/sessions`;
    assert.equal((await fetch(api)).status, 401);
    assert.equal(
      (
        await fetch(api, {
          headers: {
            Authorization: `Bearer ${token}`,
            Origin: "https://evil.example",
          },
        })
      ).status,
      403,
    );
    const response = await fetch(api, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).sessions[0].name, "srt / pi");
    const policyUrl = `${url.origin}/api/policy`;
    assert.equal((await fetch(policyUrl, { method: "POST" })).status, 401);
    const headers = {
      Authorization: `Bearer ${token}`,
      Origin: url.origin,
      "Content-Type": "application/json",
    };
    const edit = { version: 0, host: "example.com", action: "deny" };
    assert.equal(
      (
        await fetch(policyUrl, {
          method: "POST",
          headers: { ...headers, Origin: "https://evil.example" },
          body: JSON.stringify(edit),
        })
      ).status,
      403,
    );
    const updated = await fetch(policyUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(edit),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).version, 1);
    assert.equal(
      (
        await fetch(policyUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(edit),
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await fetch(policyUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...edit,
            version: 1,
            host: "https://evil.example/path",
          }),
        })
      ).status,
      409,
    );
    const page = await fetch(url.origin);
    assert.match(
      page.headers.get("content-security-policy"),
      /frame-ancestors 'none'/,
    );
    const large = `${time}  FILE       changed x\n`.repeat(10000);
    await writeFile(join(good, "activity.log"), log + large);
    const session = (await scan(root)).sessions[0];
    assert.equal(session.clipped, true);
    assert.ok(session.events.length <= 300);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
test("history keeps sessions after their logs are gone and reads only new bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "observer-history-"));
  const store = await openStore(join(root, "state", "observer.db"));
  if (!store) return; // This Node has no built-in SQLite.
  try {
    const directory = join(root, "opper-activity-one");
    const path = join(directory, "activity.log");
    await mkdir(directory);
    const acks = `${time}  POLICY     2\n`.repeat(50);
    await writeFile(path, log + acks + `${time}  TOOL       Bash start\n`);
    await archive(root, store);
    await archive(root, store);
    assert.deepEqual(store.totals("opper-activity-one"), {
      events: 4,
      blocked: 1,
      files: 1,
      tools: 1,
    });
    assert.deepEqual(store.history(["opper-activity-one"]), []);
    await writeFile(
      path,
      `${time}  POLICY     3\n${time}  SESSION    monitor stopped\n${time}  NETWORK    partial`,
      { flag: "a" },
    );
    await archive(root, store);
    assert.equal(store.totals("opper-activity-one").events, 6);
    assert.equal((await stat(store.path)).mode & 0o777, 0o600);
    await rm(directory, { recursive: true });
    await archive(root, store);
    const [session] = store.history([]);
    assert.equal(session.name, "srt / pi");
    assert.equal(session.project, "/project");
    assert.equal(session.state, "Stopped");
    assert.equal(session.archived, true);
    assert.equal(session.policyVersion, 3);
    assert.deepEqual(session.allowed, ["api.opper.ai"]);
    assert.deepEqual(
      session.events.map((e) => e.kind),
      ["SESSION", "NETWORK", "FILE", "TOOL", "POLICY", "SESSION"],
    );
    // A replaced log starts the session over instead of double counting.
    await mkdir(directory);
    await writeFile(path, `${time}  FILE       changed a\n`);
    await archive(root, store);
    assert.equal(store.totals("opper-activity-one").events, 1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
