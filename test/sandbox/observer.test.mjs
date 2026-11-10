import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scan,
  startObserver,
  summarize,
} from "../../scripts/sandbox-observer/server.mjs";
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
    const observer = await startObserver({ root });
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
