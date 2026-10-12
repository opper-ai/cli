import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newSessionId, validateTags } from "../util/session-url.js";

export const DESKTOP_SESSIONS_FILE = "desktop-sessions.json";
export const DESKTOP_SESSION_ID = /^sess_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NamedDesktopSession {
  id: string;
  name: string;
  project: string;
  tags: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}
export interface DesktopSessionsState {
  activeId: string | null;
  sessions: NamedDesktopSession[];
}
export interface DesktopSessions {
  state(): DesktopSessionsState;
  /** Creates and activates a session; persistence finishes before the live state changes. */
  create(name: string, project: string, tags?: Record<string, string>): Promise<NamedDesktopSession>;
  activate(id: string): Promise<NamedDesktopSession>;
  /** Hides a saved session and pauses attribution when it was selected. */
  archive(id: string): Promise<void>;
  /** Returns a saved session to the picker without selecting it. */
  restore(id: string): Promise<void>;
  /** Pauses attribution while retaining all named sessions. */
  clear(): Promise<void>;
}

function text(value: unknown, label: string, maxBytes: number, empty = false): string {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value) || Buffer.byteLength(value, "utf8") > maxBytes || (!empty && !value.trim())) {
    throw new Error(`invalid desktop session ${label}`);
  }
  return label === "name" ? value.trim() : value;
}
function tags(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid desktop session tags");
  const entries = Object.entries(value);
  if (entries.some(([key, val]) => key.toLowerCase() === "session_id" || typeof val !== "string")) throw new Error("invalid desktop session tags");
  const result = Object.fromEntries(entries) as Record<string, string>;
  validateTags(result);
  return result;
}
function cloneSession(value: NamedDesktopSession): NamedDesktopSession {return {...value, tags: {...value.tags}};}
function cloneState(value: DesktopSessionsState): DesktopSessionsState {return {activeId: value.activeId, sessions: value.sessions.map(cloneSession)};}
function findSession(current: DesktopSessionsState, id: string): NamedDesktopSession {
  if (typeof id !== "string" || !DESKTOP_SESSION_ID.test(id)) throw new Error("invalid desktop session ID");
  const session = current.sessions.find((item) => item.id === id);
  if (!session) throw new Error("unknown desktop session");
  return session;
}

function parseState(value: unknown): DesktopSessionsState {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["activeId", "sessions"].includes(key))) throw new Error("invalid desktop sessions file");
  const record = value as {activeId?: unknown; sessions?: unknown};
  if ((record.activeId !== null && typeof record.activeId !== "string") || !Array.isArray(record.sessions)) throw new Error("invalid desktop sessions file");
  const ids = new Set<string>();
  const sessions = record.sessions.map((item: unknown): NamedDesktopSession => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !["id", "name", "project", "tags", "createdAt", "updatedAt", "archivedAt"].includes(key))) throw new Error("invalid desktop sessions file");
    const entry = item as Partial<NamedDesktopSession>;
    if (typeof entry.id !== "string" || !DESKTOP_SESSION_ID.test(entry.id) || ids.has(entry.id)) throw new Error("invalid desktop sessions file");
    ids.add(entry.id);
    const name = text(entry.name, "name", 128);
    const project = text(entry.project, "project", 256, true);
    const selectedTags = tags(entry.tags);
    if ((selectedTags.project ?? "") !== project) throw new Error("invalid desktop sessions project tags");
    if (typeof entry.createdAt !== "string" || !Number.isFinite(Date.parse(entry.createdAt)) || typeof entry.updatedAt !== "string" || !Number.isFinite(Date.parse(entry.updatedAt))) throw new Error("invalid desktop sessions timestamps");
    if (entry.archivedAt !== undefined && (typeof entry.archivedAt !== "string" || !Number.isFinite(Date.parse(entry.archivedAt)))) throw new Error("invalid desktop sessions archive timestamp");
    return {id: entry.id, name, project, tags: selectedTags, createdAt: entry.createdAt, updatedAt: entry.updatedAt, ...(entry.archivedAt !== undefined ? {archivedAt: entry.archivedAt} : {})};
  });
  if (record.activeId !== null && !ids.has(record.activeId)) throw new Error("invalid desktop sessions active ID");
  if (sessions.some((session) => session.id === record.activeId && session.archivedAt !== undefined)) throw new Error("invalid desktop sessions archived active ID");
  return {activeId: record.activeId, sessions};
}

/** Single-daemon local registry. It stores attribution metadata only, never prompts or credentials. */
export async function openDesktopSessions(stateDir: string): Promise<DesktopSessions> {
  await mkdir(stateDir, {recursive: true, mode: 0o700});
  const file = join(stateDir, DESKTOP_SESSIONS_FILE);
  let live: DesktopSessionsState = {activeId: null, sessions: []};
  try {live = parseState(JSON.parse(await readFile(file, "utf8")));}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("cannot read saved desktop sessions", {cause: error});
  }
  let pending: Promise<void> = Promise.resolve();
  async function persist(next: DesktopSessionsState) {
    const temporary = join(stateDir, `.desktop-sessions-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", {mode: 0o600, flag: "wx"});
      await rename(temporary, file);
    } finally {await rm(temporary, {force: true});}
  }
  function mutate<T>(operation: (current: DesktopSessionsState) => {next: DesktopSessionsState; result: T}): Promise<T> {
    const action = pending.then(async () => {
      const {next, result} = operation(cloneState(live));
      await persist(next);
      live = next;
      return result;
    });
    pending = action.then(() => undefined, () => undefined);
    return action;
  }
  return {
    state: () => cloneState(live),
    create(name, project, selectedTags) {
      return mutate((current) => {
        const validName = text(name, "name", 128);
        const validProject = text(project, "project", 256, true);
        const validTags = tags(selectedTags ?? (validProject ? {project: validProject} : {}));
        if ((validTags.project ?? "") !== validProject) throw new Error("desktop session project must match its project tag");
        const now = new Date().toISOString();
        const session: NamedDesktopSession = {id: newSessionId(), name: validName, project: validProject, tags: validTags, createdAt: now, updatedAt: now};
        return {next: {activeId: session.id, sessions: [...current.sessions, session]}, result: cloneSession(session)};
      });
    },
    activate(id) {
      return mutate((current) => {
        const session = findSession(current, id);
        if (session.archivedAt !== undefined) throw new Error("restore an archived desktop session before selecting it");
        session.updatedAt = new Date().toISOString();
        return {next: {activeId: session.id, sessions: current.sessions}, result: cloneSession(session)};
      });
    },
    archive(id) {
      return mutate((current) => {
        const session = findSession(current, id);
        if (session.archivedAt === undefined) {
          session.archivedAt = new Date().toISOString();
          session.updatedAt = session.archivedAt;
        }
        return {next: {...current, activeId: current.activeId === id ? null : current.activeId}, result: undefined};
      });
    },
    restore(id) {
      return mutate((current) => {
        const session = findSession(current, id);
        if (session.archivedAt !== undefined) {
          delete session.archivedAt;
          session.updatedAt = new Date().toISOString();
        }
        return {next: current, result: undefined};
      });
    },
    clear: () => mutate((current) => ({next: {...current, activeId: null}, result: undefined})),
  };
}
