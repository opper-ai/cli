import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { openDesktopSessions, DESKTOP_SESSIONS_FILE } from "../../src/desktop/sessions.js";

const temporary: string[] = [];
afterEach(async () => {await Promise.all(temporary.splice(0).map((directory) => rm(directory, {recursive: true, force: true})));});
async function directory() {const path = await mkdtemp(join(tmpdir(), "opper-desktop-sessions-")); temporary.push(path); return path;}

describe("persistent desktop attribution sessions", () => {
  it("creates named sessions, activates old stable IDs, and restores after restart", async () => {
    const path = await directory();
    const store = await openDesktopSessions(path);
    expect(store.state()).toEqual({activeId: null, sessions: []});
    const a = await store.create("Acme onboarding", "acme");
    const b = await store.create("Beta planning", "beta");
    expect(a.id).toMatch(/^sess_/);
    expect(a).toMatchObject({name: "Acme onboarding", project: "acme", tags: {project: "acme"}});
    expect(store.state().activeId).toBe(b.id);
    expect((await store.activate(a.id)).id).toBe(a.id);
    const reopened = await openDesktopSessions(path);
    expect(reopened.state().activeId).toBe(a.id);
    expect(reopened.state().sessions.map((session) => session.id)).toEqual([a.id, b.id]);
    await reopened.clear();
    expect((await openDesktopSessions(path)).state()).toMatchObject({activeId: null, sessions: [{id: a.id}, {id: b.id}]});
    expect((await stat(join(path, DESKTOP_SESSIONS_FILE))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(path, DESKTOP_SESSIONS_FILE), "utf8")).not.toMatch(/token|credential|prompt|authorization/i);
  });

  it("serializes concurrent mutations, preserves arbitrary legacy tags, and returns defensive copies", async () => {
    const store = await openDesktopSessions(await directory());
    const sessions = await Promise.all([store.create("A", "a"), store.create("B", "b"), store.create("C", "", {team: "tools"})]);
    expect(store.state().sessions.map((session) => session.id)).toEqual(sessions.map((session) => session.id));
    expect(store.state().activeId).toBe(sessions[2]!.id);
    sessions[0]!.tags.project = "tampered";
    const copy = store.state();
    copy.sessions[0]!.tags.project = "tampered";
    copy.sessions.length = 0;
    expect(store.state().sessions).toHaveLength(3);
    expect((await store.activate(sessions[0]!.id)).tags).toEqual({project: "a"});
    expect((await store.create("Legacy project", " acme ", {project: " acme ", team: "tools"})).tags).toEqual({project: " acme ", team: "tools"});
  });

  it("rejects invalid metadata and leaves prior selection unchanged", async () => {
    const store = await openDesktopSessions(await directory());
    const a = await store.create("A", "a");
    for (const [name, project] of [["", "a"], ["x".repeat(129), "a"], ["A\nB", "a"], ["A", "x".repeat(257)], ["A", "a\n"]]) {
      await expect(store.create(name!, project!)).rejects.toThrow();
    }
    await expect(store.create("A", "a", {project: "other"})).rejects.toThrow();
    await expect(store.create("A", "", {session_id: "override"})).rejects.toThrow();
    await expect(store.activate("sess_nonexistent")).rejects.toThrow();
    expect(store.state()).toMatchObject({activeId: a.id, sessions: [{id: a.id}]});
  });

  it("persists before exposing new selection and recovers its queue after a write failure", async () => {
    const path = await directory();
    const store = await openDesktopSessions(path);
    await mkdir(join(path, DESKTOP_SESSIONS_FILE));
    await expect(store.create("A", "a")).rejects.toThrow();
    expect(store.state()).toEqual({activeId: null, sessions: []});
    await rm(join(path, DESKTOP_SESSIONS_FILE), {recursive: true});
    const b = await store.create("B", "b");
    expect((await openDesktopSessions(path)).state().activeId).toBe(b.id);
  });

  it("refuses corrupt saved data without replacing it", async () => {
    const path = await directory();
    const file = join(path, DESKTOP_SESSIONS_FILE);
    const corrupt = '{"activeId":"missing","sessions":[]}';
    await writeFile(file, corrupt);
    await expect(openDesktopSessions(path)).rejects.toThrow(/sessions/i);
    expect(await readFile(file, "utf8")).toBe(corrupt);
    await writeFile(file, '{"activeId":null,"sessions":[],"credential":"secret"}');
    await expect(openDesktopSessions(path)).rejects.toThrow(/sessions/i);
  });
});
