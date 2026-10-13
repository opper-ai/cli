import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDesktopSessions, DESKTOP_SESSIONS_FILE } from "../../src/desktop/sessions.js";
import { ensurePrivateStateDirectory, assertPrivateStateFile } from "../../src/desktop/private-state.js";

const temporary: string[] = [];
afterEach(async () => {vi.useRealTimers(); await Promise.all(temporary.splice(0).map((directory) => rm(directory, {recursive: true, force: true})));});
async function directory() {const root = await mkdtemp(join(tmpdir(), "opper-desktop-sessions-")); temporary.push(root); const path=join(root,"state"); await ensurePrivateStateDirectory(path,true); return path;}

describe("persistent desktop attribution sessions", {timeout: process.platform === "win32" ? 60_000 : 5_000}, () => {
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
    if (process.platform === "win32") await assertPrivateStateFile(join(path, DESKTOP_SESSIONS_FILE));
    else expect((await stat(join(path, DESKTOP_SESSIONS_FILE))).mode & 0o777).toBe(0o600);
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

  it("archives the active session, persists its first timestamp, and restores the same ID without selecting", async () => {
    vi.useFakeTimers({toFake: ["Date"]});
    vi.setSystemTime(new Date("2026-10-12T08:00:00.000Z"));
    const path = await directory();
    const store = await openDesktopSessions(path);
    const session = await store.create("Acme", "acme", {project: "acme", team: "tools"});
    vi.setSystemTime(new Date("2026-10-12T09:00:00.000Z"));
    await store.archive(session.id);
    expect(store.state()).toMatchObject({activeId: null, sessions: [{...session, updatedAt: "2026-10-12T09:00:00.000Z", archivedAt: "2026-10-12T09:00:00.000Z"}]});
    const reopened = await openDesktopSessions(path);
    await expect(reopened.activate(session.id)).rejects.toThrow(/archived/i);
    vi.setSystemTime(new Date("2026-10-12T10:00:00.000Z"));
    await reopened.archive(session.id);
    expect(reopened.state().sessions[0]!.archivedAt).toBe("2026-10-12T09:00:00.000Z");
    await reopened.restore(session.id);
    expect(reopened.state().activeId).toBeNull();
    expect(reopened.state().sessions[0]).not.toHaveProperty("archivedAt");
    await reopened.restore(session.id);
    expect(reopened.state().activeId).toBeNull();
    const restored = await openDesktopSessions(path);
    expect((await restored.activate(session.id))).toMatchObject({id: session.id, tags: session.tags, createdAt: session.createdAt});
    expect(restored.state().sessions).toHaveLength(1);
  });

  it("archives an inactive session without changing the selected session and returns defensive archived metadata", async () => {
    const store = await openDesktopSessions(await directory());
    const a = await store.create("A", "a");
    const b = await store.create("B", "b");
    await store.archive(a.id);
    expect(store.state().activeId).toBe(b.id);
    const copied = store.state();
    copied.sessions[0]!.archivedAt = "tampered";
    copied.sessions[0]!.tags.project = "tampered";
    expect(store.state().sessions[0]).toMatchObject({tags: a.tags, archivedAt: expect.any(String)});
    expect(store.state().sessions[0]!.archivedAt).not.toBe("tampered");
    await store.restore(a.id);
    expect(store.state().activeId).toBe(b.id);
    for (const id of ["bad", "sess_11111111-1111-4111-8111-111111111111"]) {
      await expect(store.archive(id)).rejects.toThrow();
      await expect(store.restore(id)).rejects.toThrow();
    }
    expect(store.state().activeId).toBe(b.id);
  });

  it("does not expose archive or restore changes if persistence fails", async () => {
    const path = await directory();
    const file = join(path, DESKTOP_SESSIONS_FILE);
    const store = await openDesktopSessions(path);
    const session = await store.create("A", "a");
    await rm(file); await mkdir(file);
    await expect(store.archive(session.id)).rejects.toThrow();
    expect(store.state()).toMatchObject({activeId: session.id, sessions: [session]});
    await rm(file, {recursive: true});
    await store.archive(session.id);
    const archived = store.state();
    await rm(file); await mkdir(file);
    await expect(store.restore(session.id)).rejects.toThrow();
    expect(store.state()).toEqual(archived);
    await rm(file, {recursive: true});
    await store.restore(session.id);
    expect((await openDesktopSessions(path)).state().sessions[0]).not.toHaveProperty("archivedAt");
    expect(await readdir(path)).toEqual([DESKTOP_SESSIONS_FILE]);
  });

  it("accepts legacy entries but rejects malformed archive timestamps and archived active IDs", async () => {
    const path = await directory();
    const file = join(path, DESKTOP_SESSIONS_FILE);
    const store = await openDesktopSessions(path);
    await store.create("Legacy", "legacy");
    const legacy = store.state();
    expect((await openDesktopSessions(path)).state()).toEqual(legacy);
    for (const archivedAt of [null, 42, "", "not-a-date"]) {
      const invalid = {...legacy, activeId: null, sessions: legacy.sessions.map((session) => ({...session, archivedAt}))};
      await writeFile(file, JSON.stringify(invalid));
      await expect(openDesktopSessions(path)).rejects.toThrow(/sessions/i);
    }
    const invalidActive = {...legacy, sessions: legacy.sessions.map((session) => ({...session, archivedAt: "2026-10-12T09:00:00.000Z"}))};
    await writeFile(file, JSON.stringify(invalidActive));
    await expect(openDesktopSessions(path)).rejects.toThrow(/sessions/i);
  });
});
