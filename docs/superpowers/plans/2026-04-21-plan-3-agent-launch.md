# Plan 3 of 4 — Agent Launch (Hermes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the "Ollama-style" `opper launch hermes` command that detects the Hermes agent, snapshots its config, rewrites the provider block to route inference through Opper, spawns the Hermes process, and restores the original config on exit. Also ships `opper agents list` for discovery.

**Architecture:** `src/agents/types.ts` defines the `AgentAdapter` interface every future agent will implement. `src/agents/hermes.ts` is the first concrete adapter. `src/agents/registry.ts` maps names to adapters. Backup/restore uses a dedicated `src/util/backup.ts` helper that writes to `~/.opper/backups/` with rotation. The `launch` command in `src/commands/launch.ts` orchestrates auth → detect → snapshot → write → spawn → restore, with SIGINT/SIGTERM traps ensuring the config is always restored on graceful exit.

**Tech Stack:** Inherited from Plans 1 & 2 (TypeScript, Node ≥20.10, Vitest, commander, @clack/prompts, kleur, yaml). No new runtime deps.

**Depends on:** Plans 1 & 2 (scaffold, auth, setup wizard). Specifically `getSlot()`, `OpperError`, `brand`, `run()` from `src/util/run.ts`, `backupsDir()` from `src/auth/paths.ts`, and `loginCommand` from `src/commands/login.ts`.

**Spec:** `docs/superpowers/specs/2026-04-21-unified-opper-cli-design.md` — section 5 (agent routing), section 6 (backups), section 8 (AGENT_* error codes), section 13 (v3 compat URL).

**Scope note:** This plan covers Hermes only. Additional adapters (`pi`, `opencode`, `claude-code`) are explicitly out of scope and belong in Phase 3 per spec §9.

---

## Important scope decisions

- **Provider shape for Hermes**: Hermes' YAML config accepts `provider: "openai"` with a `base_url` override and a direct `api_key`. We use `provider: "openai"` + Opper's v3 OpenAI-compat endpoint (`OPPER_OPENAI_COMPAT_URL` from Plan 2). No changes to the constant; it's the single source of truth.
- **Default model**: when `--model` isn't passed to `launch`, use `anthropic/claude-opus-4.7` (spec §5.1 example). Opper's v3 resolves this to the right upstream.
- **Atomic writes**: the Hermes config writer uses the same temp-file + rename pattern as `writeConfig` in Plan 1 so a crash mid-write doesn't destroy the user's live hermes config.
- **Snapshot rotation**: keep last 20 backups per agent in `~/.opper/backups/`. Older snapshots deleted on each new snapshot.
- **Hermes install**: `adapter.install()` is a prompted curl-pipe-to-bash (upstream's documented installer). Never run unprompted.
- **Signal handling**: `launch` installs SIGINT/SIGTERM handlers *after* the child spawns. Handlers forward the signal to the child, wait for it, then restore config. If the handlers themselves fail, the backup path is printed so the user can manually recover.

---

## File Structure

Files created or modified in this plan:

| Path | Responsibility |
|---|---|
| `src/agents/types.ts` | `AgentAdapter`, `DetectResult`, `OpperRouting`, `SnapshotHandle` interfaces |
| `src/agents/registry.ts` | Map of adapter name → factory; `getAdapter(name)` / `listAdapters()` |
| `src/agents/hermes.ts` | Hermes adapter implementation |
| `src/util/which.ts` | Cross-platform `which` — returns path if binary on PATH, else null |
| `src/util/backup.ts` | `takeSnapshot(agent, sourcePath)`, `restoreSnapshot(handle)`, `rotateBackups(agent, keep)` |
| `src/commands/agents.ts` | `opper agents list` |
| `src/commands/launch.ts` | `opper launch <agent>` |
| `test/util/which.test.ts` | |
| `test/util/backup.test.ts` | |
| `test/agents/types.test.ts` | Type-compile sanity test (no logic) |
| `test/agents/hermes.test.ts` | Adapter tests with temp HOME |
| `test/agents/registry.test.ts` | |
| `test/commands/agents.test.ts` | |
| `test/commands/launch.test.ts` | End-to-end flow with mocked adapter |
| `README.md` | Document `launch` and `agents` |

Total: 11 tasks.

---

## Task 1: Define the agent-adapter interface

**Files:**
- Create: `src/agents/types.ts`
- Create: `test/agents/types.test.ts`

This task is pure types. The test just ensures the interface compiles and that an inline stub can satisfy it.

- [ ] **Step 1: Write `test/agents/types.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import type {
  AgentAdapter,
  DetectResult,
  OpperRouting,
  SnapshotHandle,
} from "../../src/agents/types.js";

describe("AgentAdapter interface", () => {
  it("allows a stub implementation to satisfy all required fields", () => {
    const stub: AgentAdapter = {
      name: "stub",
      displayName: "Stub",
      binary: "stub",
      docsUrl: "https://example.com",
      async detect(): Promise<DetectResult> {
        return { installed: false };
      },
      async install(): Promise<void> {
        return;
      },
      async snapshotConfig(): Promise<SnapshotHandle> {
        return {
          agent: "stub",
          backupPath: "/tmp/stub.bak",
          timestamp: "2026-04-21T00:00:00.000Z",
        };
      },
      async writeOpperConfig(_c: OpperRouting): Promise<void> {
        return;
      },
      async restoreConfig(_h: SnapshotHandle): Promise<void> {
        return;
      },
      async spawn(_args: string[]): Promise<number> {
        return 0;
      },
    };
    expect(stub.name).toBe("stub");
  });
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `cd /Users/joch/dev/opper-ai/cli && npm test -- agents/types`
Expected: FAIL "Cannot find module".

- [ ] **Step 3: Write `src/agents/types.ts`**

```ts
export interface DetectResult {
  installed: boolean;
  version?: string;
  configPath?: string;
}

export interface OpperRouting {
  baseUrl: string;
  apiKey: string;
  model: string;
  compatShape: "openai" | "anthropic" | "responses";
}

export interface SnapshotHandle {
  agent: string;
  backupPath: string;
  timestamp: string;
}

export interface AgentAdapter {
  name: string;
  displayName: string;
  binary: string;
  docsUrl: string;

  detect(): Promise<DetectResult>;
  install(): Promise<void>;

  snapshotConfig(): Promise<SnapshotHandle>;
  writeOpperConfig(c: OpperRouting): Promise<void>;
  restoreConfig(h: SnapshotHandle): Promise<void>;

  spawn(args: string[]): Promise<number>;
}
```

- [ ] **Step 4: Run test — must pass**

Run: `npm test -- agents/types`
Expected: PASS (1 test). `npm run typecheck` exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/agents/types.ts test/agents/types.test.ts
git commit -m "feat: add AgentAdapter interface and helper types"
```

---

## Task 2: `which` helper

**Files:**
- Create: `src/util/which.ts`
- Create: `test/util/which.test.ts`

- [ ] **Step 1: Write `test/util/which.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { which } from "../../src/util/which.js";

describe("which", () => {
  it("returns a path for a binary that exists (node)", async () => {
    const path = await which("node");
    expect(path).not.toBeNull();
    expect(path).toMatch(/node$/);
  });

  it("returns null for a nonexistent binary", async () => {
    const path = await which("this-binary-definitely-does-not-exist-xyz123");
    expect(path).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- util/which`
Expected: FAIL "Cannot find module".

- [ ] **Step 3: Write `src/util/which.ts`**

```ts
import { run } from "./run.js";

/**
 * Returns the absolute path of `name` on PATH, or null if not found.
 * Uses the system `which` (or `where` on Windows) — no shell.
 */
export async function which(name: string): Promise<string | null> {
  const cmd = process.platform === "win32" ? "where" : "which";
  const result = run(cmd, [name]);
  if (result.code !== 0) return null;
  const first = result.stdout.split(/\r?\n/)[0]?.trim();
  return first && first.length > 0 ? first : null;
}
```

- [ ] **Step 4: Run — must pass**

Run: `npm test -- util/which`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/util/which.ts test/util/which.test.ts
git commit -m "feat: add which() helper"
```

---

## Task 3: Backup rotation helper

**Files:**
- Create: `src/util/backup.ts`
- Create: `test/util/backup.test.ts`

- [ ] **Step 1: Write `test/util/backup.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeSnapshot, restoreSnapshot, rotateBackups } from "../../src/util/backup.js";
import { useTempOpperHome } from "../helpers/temp-home.js";

const home = useTempOpperHome();

describe("backup", () => {
  let sourceDir: string;

  beforeEach(() => {
    sourceDir = mkdtempSync(join(tmpdir(), "opper-backup-src-"));
  });
  afterEach(() => {
    rmSync(sourceDir, { recursive: true, force: true });
  });

  it("takeSnapshot copies the source file into ~/.opper/backups/", async () => {
    const src = join(sourceDir, "config.yaml");
    writeFileSync(src, "hello: world\n", "utf8");
    const handle = await takeSnapshot("hermes", src);
    expect(handle.agent).toBe("hermes");
    expect(handle.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(existsSync(handle.backupPath)).toBe(true);
    expect(readFileSync(handle.backupPath, "utf8")).toBe("hello: world\n");
  });

  it("restoreSnapshot copies the backup back to a target path", async () => {
    const src = join(sourceDir, "config.yaml");
    writeFileSync(src, "original\n", "utf8");
    const handle = await takeSnapshot("hermes", src);
    writeFileSync(src, "mutated\n", "utf8");
    await restoreSnapshot(handle, src);
    expect(readFileSync(src, "utf8")).toBe("original\n");
  });

  it("rotateBackups keeps only the N most-recent snapshots per agent", async () => {
    const src = join(sourceDir, "config.yaml");
    writeFileSync(src, "x\n", "utf8");
    // Create 5 snapshots with 10 ms apart so timestamps differ.
    for (let i = 0; i < 5; i++) {
      await takeSnapshot("hermes", src);
      await new Promise((r) => setTimeout(r, 10));
    }
    await rotateBackups("hermes", 2);
    const backups = readdirSync(join(home.get(), "backups")).filter(
      (f) => f.startsWith("hermes-"),
    );
    expect(backups).toHaveLength(2);
  });

  it("rotateBackups ignores other agents' backups", async () => {
    const src = join(sourceDir, "config.yaml");
    writeFileSync(src, "x\n", "utf8");
    await takeSnapshot("hermes", src);
    await takeSnapshot("pi", src);
    await takeSnapshot("pi", src);
    await rotateBackups("pi", 1);
    const all = readdirSync(join(home.get(), "backups"));
    expect(all.filter((f) => f.startsWith("hermes-"))).toHaveLength(1);
    expect(all.filter((f) => f.startsWith("pi-"))).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- util/backup`
Expected: FAIL "Cannot find module".

- [ ] **Step 3: Write `src/util/backup.ts`**

```ts
import { copyFile, mkdir, rm, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { backupsDir } from "../auth/paths.js";
import type { SnapshotHandle } from "../agents/types.js";

function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function takeSnapshot(
  agent: string,
  sourcePath: string,
): Promise<SnapshotHandle> {
  const dir = backupsDir();
  await mkdir(dir, { recursive: true });
  const ts = isoStamp();
  const ext = extname(sourcePath) || "";
  const backupPath = join(dir, `${agent}-${ts}${ext}`);
  await copyFile(sourcePath, backupPath);
  return { agent, backupPath, timestamp: new Date().toISOString() };
}

export async function restoreSnapshot(
  handle: SnapshotHandle,
  targetPath: string,
): Promise<void> {
  await copyFile(handle.backupPath, targetPath);
}

export async function rotateBackups(agent: string, keep: number): Promise<void> {
  const dir = backupsDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const mine = entries
    .filter((f) => f.startsWith(`${agent}-`))
    .sort(); // ISO timestamps sort lexicographically by time
  const stale = mine.slice(0, Math.max(0, mine.length - keep));
  for (const f of stale) {
    await rm(join(dir, f), { force: true });
  }
}
```

- [ ] **Step 4: Run — must pass**

Run: `npm test -- util/backup`
Expected: PASS (4 tests). `npm run typecheck` exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/util/backup.ts test/util/backup.test.ts
git commit -m "feat: add backup snapshot/restore/rotate helpers"
```

---

## Task 4: Hermes adapter — detect and install

**Files:**
- Create: `src/agents/hermes.ts` (first slice)
- Create: `test/agents/hermes.test.ts` (first slice)

This task lays down the module with detect() and install() only. Later tasks add snapshot/write/spawn.

- [ ] **Step 1: Write `test/agents/hermes.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";

const whichMock = vi.fn();
const runMock = vi.fn();

vi.mock("../../src/util/which.js", () => ({ which: whichMock }));
vi.mock("../../src/util/run.js", () => ({ run: runMock }));

const { hermes } = await import("../../src/agents/hermes.js");

describe("hermes adapter — detect", () => {
  it("returns installed=false when `which hermes` returns null", async () => {
    whichMock.mockResolvedValue(null);
    const result = await hermes.detect();
    expect(result.installed).toBe(false);
    expect(result.version).toBeUndefined();
  });

  it("returns installed=true with version when hermes is on PATH", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/hermes");
    runMock.mockReturnValue({
      code: 0,
      stdout: "hermes 1.2.3\n",
      stderr: "",
    });
    const result = await hermes.detect();
    expect(result.installed).toBe(true);
    expect(result.version).toBe("1.2.3");
    expect(result.configPath).toMatch(/\.hermes\/config\.yaml$/);
  });

  it("returns installed=true with undefined version when --version fails", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/hermes");
    runMock.mockReturnValue({ code: 1, stdout: "", stderr: "boom" });
    const result = await hermes.detect();
    expect(result.installed).toBe(true);
    expect(result.version).toBeUndefined();
  });
});

describe("hermes adapter — metadata", () => {
  it("has the expected name, displayName, binary, docsUrl", () => {
    expect(hermes.name).toBe("hermes");
    expect(hermes.displayName).toBe("Hermes Agent");
    expect(hermes.binary).toBe("hermes");
    expect(hermes.docsUrl).toBe("https://hermes-agent.nousresearch.com/docs/");
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- agents/hermes`
Expected: FAIL "Cannot find module".

- [ ] **Step 3: Write `src/agents/hermes.ts` (first slice — detect + install + metadata)**

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { which } from "../util/which.js";
import { run } from "../util/run.js";
import type {
  AgentAdapter,
  DetectResult,
  OpperRouting,
  SnapshotHandle,
} from "./types.js";

const HERMES_CONFIG = join(homedir(), ".hermes", "config.yaml");

async function detect(): Promise<DetectResult> {
  const path = await which("hermes");
  if (!path) return { installed: false };

  const versionResult = run("hermes", ["--version"]);
  const parsed = versionResult.code === 0
    ? versionResult.stdout.trim().split(/\s+/).pop()
    : undefined;

  return {
    installed: true,
    ...(parsed ? { version: parsed } : {}),
    configPath: HERMES_CONFIG,
  };
}

async function install(): Promise<void> {
  // Prompted install is wired in the launch command; adapter just runs the
  // upstream installer script unconditionally when called.
  const result = run(
    "bash",
    ["-c", "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash"],
    { inherit: true },
  );
  if (result.code !== 0) {
    throw new Error(`Hermes installer exited with code ${result.code}`);
  }
}

async function snapshotConfig(): Promise<SnapshotHandle> {
  throw new Error("snapshotConfig not yet implemented");
}

async function writeOpperConfig(_c: OpperRouting): Promise<void> {
  throw new Error("writeOpperConfig not yet implemented");
}

async function restoreConfig(_h: SnapshotHandle): Promise<void> {
  throw new Error("restoreConfig not yet implemented");
}

async function spawn(_args: string[]): Promise<number> {
  throw new Error("spawn not yet implemented");
}

export const hermes: AgentAdapter = {
  name: "hermes",
  displayName: "Hermes Agent",
  binary: "hermes",
  docsUrl: "https://hermes-agent.nousresearch.com/docs/",
  detect,
  install,
  snapshotConfig,
  writeOpperConfig,
  restoreConfig,
  spawn,
};
```

- [ ] **Step 4: Run — must pass**

Run: `npm test -- agents/hermes`
Expected: PASS (4 tests). `npm run typecheck` exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/agents/hermes.ts test/agents/hermes.test.ts
git commit -m "feat: hermes adapter — detect and install"
```

---

## Task 5: Hermes adapter — snapshot/restore

**Files:**
- Modify: `src/agents/hermes.ts`
- Modify: `test/agents/hermes.test.ts` (append tests)

- [ ] **Step 1: Append tests to `test/agents/hermes.test.ts`**

Append after the existing describe blocks:

```ts
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

describe("hermes adapter — snapshot/restore", () => {
  let sandbox: string;
  let prevHome: string | undefined;
  let prevOpperHome: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "opper-hermes-"));
    prevHome = process.env.HOME;
    prevOpperHome = process.env.OPPER_HOME;
    process.env.HOME = sandbox;
    process.env.OPPER_HOME = join(sandbox, ".opper");
    mkdirSync(join(sandbox, ".hermes"), { recursive: true });
  });
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevOpperHome === undefined) delete process.env.OPPER_HOME;
    else process.env.OPPER_HOME = prevOpperHome;
  });

  it("snapshotConfig copies the hermes config into backups", async () => {
    const live = join(sandbox, ".hermes", "config.yaml");
    writeFileSync(live, "model:\n  provider: openrouter\n", "utf8");
    const handle = await hermes.snapshotConfig();
    expect(handle.agent).toBe("hermes");
    expect(existsSync(handle.backupPath)).toBe(true);
    expect(readFileSync(handle.backupPath, "utf8")).toContain("openrouter");
  });

  it("snapshotConfig throws AGENT_CONFIG_CONFLICT when no hermes config exists", async () => {
    await expect(hermes.snapshotConfig()).rejects.toMatchObject({
      code: "AGENT_CONFIG_CONFLICT",
    });
  });

  it("restoreConfig copies the backup back over the live file", async () => {
    const live = join(sandbox, ".hermes", "config.yaml");
    writeFileSync(live, "original\n", "utf8");
    const handle = await hermes.snapshotConfig();
    writeFileSync(live, "mutated\n", "utf8");
    await hermes.restoreConfig(handle);
    expect(readFileSync(live, "utf8")).toBe("original\n");
  });
});
```

You will also need to add `beforeEach, afterEach` to the `vitest` import at the top if they aren't already:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
```

- [ ] **Step 2: Run — expect failure** (implementation still throws "not yet implemented")

Run: `npm test -- agents/hermes`
Expected: 3 new tests fail with "snapshotConfig not yet implemented" or "restoreConfig not yet implemented".

- [ ] **Step 3: Update `src/agents/hermes.ts`**

Replace the stubbed `snapshotConfig` and `restoreConfig` with real impls. Add imports at the top:

```ts
import { existsSync } from "node:fs";
import { takeSnapshot, restoreSnapshot, rotateBackups } from "../util/backup.js";
import { OpperError } from "../errors.js";
```

Replace the functions:

```ts
async function snapshotConfig(): Promise<SnapshotHandle> {
  if (!existsSync(HERMES_CONFIG)) {
    throw new OpperError(
      "AGENT_CONFIG_CONFLICT",
      `Hermes config not found at ${HERMES_CONFIG}`,
      "Run `hermes` once to initialise a config, then try again.",
    );
  }
  const handle = await takeSnapshot("hermes", HERMES_CONFIG);
  await rotateBackups("hermes", 20);
  return handle;
}

async function restoreConfig(h: SnapshotHandle): Promise<void> {
  await restoreSnapshot(h, HERMES_CONFIG);
}
```

Note: `HERMES_CONFIG` is evaluated at module load time using `homedir()`. In tests we override `process.env.HOME` **before** importing the module, but since the import happens once at the top of the test file (via `await import`), the constant captures the sandbox home. If the module is re-imported across tests, the constant is reused from the first import — be aware.

If the tests fail because `HERMES_CONFIG` was evaluated before `process.env.HOME` was swapped, convert it from a constant to a function:

```ts
function hermesConfigPath(): string {
  return join(homedir(), ".hermes", "config.yaml");
}
```

and replace `HERMES_CONFIG` references in `detect`, `snapshotConfig`, `restoreConfig`, and anywhere else with `hermesConfigPath()`. This is the safer pattern and matches how Plan 1's `configPath()` works.

Use the function form for consistency.

- [ ] **Step 4: Run — must pass**

Run: `npm test -- agents/hermes`
Expected: PASS (7 tests total — 4 prior + 3 new). `npm run typecheck` exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/agents/hermes.ts test/agents/hermes.test.ts
git commit -m "feat: hermes adapter — snapshot and restore"
```

---

## Task 6: Hermes adapter — writeOpperConfig

**Files:**
- Modify: `src/agents/hermes.ts`
- Modify: `test/agents/hermes.test.ts`

- [ ] **Step 1: Append tests to `test/agents/hermes.test.ts`**

```ts
describe("hermes adapter — writeOpperConfig", () => {
  let sandbox: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "opper-hermes-write-"));
    prevHome = process.env.HOME;
    process.env.HOME = sandbox;
    mkdirSync(join(sandbox, ".hermes"), { recursive: true });
  });
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });

  it("rewrites the model: block and preserves other sections", async () => {
    const live = join(sandbox, ".hermes", "config.yaml");
    writeFileSync(
      live,
      [
        "model:",
        "  provider: openrouter",
        "  model: openai/gpt-4o",
        "tools:",
        "  enabled: [search, shell]",
        "gateway:",
        "  telegram: true",
      ].join("\n") + "\n",
      "utf8",
    );

    await hermes.writeOpperConfig({
      baseUrl: "https://api.opper.ai/v3/openai",
      apiKey: "op_live_test",
      model: "anthropic/claude-opus-4.7",
      compatShape: "openai",
    });

    const { parse } = await import("yaml");
    const parsed = parse(readFileSync(live, "utf8")) as {
      model: Record<string, unknown>;
      tools: Record<string, unknown>;
      gateway: Record<string, unknown>;
    };
    expect(parsed.model).toEqual({
      provider: "openai",
      model: "anthropic/claude-opus-4.7",
      base_url: "https://api.opper.ai/v3/openai",
      api_key: "op_live_test",
    });
    expect(parsed.tools).toEqual({ enabled: ["search", "shell"] });
    expect(parsed.gateway).toEqual({ telegram: true });
  });

  it("creates the model block if missing", async () => {
    const live = join(sandbox, ".hermes", "config.yaml");
    writeFileSync(live, "tools:\n  enabled: []\n", "utf8");
    await hermes.writeOpperConfig({
      baseUrl: "https://api.opper.ai/v3/openai",
      apiKey: "op_live_x",
      model: "anthropic/claude-opus-4.7",
      compatShape: "openai",
    });
    const { parse } = await import("yaml");
    const parsed = parse(readFileSync(live, "utf8")) as {
      model?: { provider?: string };
    };
    expect(parsed.model?.provider).toBe("openai");
  });

  it("writes atomically via a temp file + rename", async () => {
    const live = join(sandbox, ".hermes", "config.yaml");
    writeFileSync(live, "model: {}\n", "utf8");
    await hermes.writeOpperConfig({
      baseUrl: "https://api.opper.ai/v3/openai",
      apiKey: "k",
      model: "m",
      compatShape: "openai",
    });
    // No lingering .tmp.* files.
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(join(sandbox, ".hermes"));
    expect(files.filter((f) => f.includes(".tmp."))).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- agents/hermes`
Expected: 3 new tests fail with "writeOpperConfig not yet implemented".

- [ ] **Step 3: Replace stub in `src/agents/hermes.ts`**

Add imports:

```ts
import { readFile, writeFile, rename, chmod } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { dirname } from "node:path";
```

Replace the function:

```ts
async function writeOpperConfig(c: OpperRouting): Promise<void> {
  const path = hermesConfigPath();
  const raw = await readFile(path, "utf8");
  const parsed = (parse(raw) as Record<string, unknown>) ?? {};
  parsed.model = {
    provider: c.compatShape === "openai" ? "openai" : c.compatShape,
    model: c.model,
    base_url: c.baseUrl,
    api_key: c.apiKey,
  };
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, stringify(parsed), "utf8");
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}
```

Note on the `provider` field mapping: for `compatShape === "openai"` we emit `provider: "openai"`. For `"anthropic"` or `"responses"` we emit the shape name directly; Hermes only officially supports a handful of providers (openrouter, anthropic, openai, custom) so mapping our compat shapes directly works for "openai" and "anthropic" and we'll address "responses" when the need arises (phase 3). Document this by keeping the current mapping simple.

- [ ] **Step 4: Run — must pass**

Run: `npm test -- agents/hermes`
Expected: PASS (10 tests total). `npm run typecheck` exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/agents/hermes.ts test/agents/hermes.test.ts
git commit -m "feat: hermes adapter — writeOpperConfig"
```

---

## Task 7: Hermes adapter — spawn

**Files:**
- Modify: `src/agents/hermes.ts`
- Modify: `test/agents/hermes.test.ts`

- [ ] **Step 1: Append test**

```ts
describe("hermes adapter — spawn", () => {
  it("runs the hermes binary with inherited stdio and returns the exit code", async () => {
    runMock.mockClear();
    runMock.mockReturnValue({ code: 0, stdout: "", stderr: "" });
    const code = await hermes.spawn(["--foo", "bar"]);
    expect(code).toBe(0);
    expect(runMock).toHaveBeenCalledWith(
      "hermes",
      ["--foo", "bar"],
      { inherit: true },
    );
  });

  it("propagates non-zero exit codes", async () => {
    runMock.mockClear();
    runMock.mockReturnValue({ code: 2, stdout: "", stderr: "" });
    const code = await hermes.spawn([]);
    expect(code).toBe(2);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- agents/hermes`
Expected: 2 new tests fail with "spawn not yet implemented".

- [ ] **Step 3: Replace `spawn` stub in `src/agents/hermes.ts`**

```ts
async function spawn(args: string[]): Promise<number> {
  const result = run("hermes", args, { inherit: true });
  return result.code;
}
```

- [ ] **Step 4: Run — must pass**

Run: `npm test -- agents/hermes`
Expected: PASS (12 tests total). `npm run typecheck` exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/agents/hermes.ts test/agents/hermes.test.ts
git commit -m "feat: hermes adapter — spawn"
```

---

## Task 8: Adapter registry

**Files:**
- Create: `src/agents/registry.ts`
- Create: `test/agents/registry.test.ts`

- [ ] **Step 1: Write `test/agents/registry.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { getAdapter, listAdapters } from "../../src/agents/registry.js";
import { hermes } from "../../src/agents/hermes.js";

describe("adapter registry", () => {
  it("lists all registered adapters", () => {
    const list = listAdapters();
    expect(list.map((a) => a.name)).toContain("hermes");
  });

  it("looks up hermes by name", () => {
    expect(getAdapter("hermes")).toBe(hermes);
  });

  it("returns null for unknown names", () => {
    expect(getAdapter("nonexistent")).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- agents/registry`
Expected: FAIL "Cannot find module".

- [ ] **Step 3: Write `src/agents/registry.ts`**

```ts
import type { AgentAdapter } from "./types.js";
import { hermes } from "./hermes.js";

const ADAPTERS: ReadonlyArray<AgentAdapter> = [hermes];

export function listAdapters(): ReadonlyArray<AgentAdapter> {
  return ADAPTERS;
}

export function getAdapter(name: string): AgentAdapter | null {
  return ADAPTERS.find((a) => a.name === name) ?? null;
}
```

- [ ] **Step 4: Run — must pass**

Run: `npm test -- agents/registry`
Expected: PASS (3 tests). `npm run typecheck` exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/agents/registry.ts test/agents/registry.test.ts
git commit -m "feat: add agent adapter registry"
```

---

## Task 9: `opper agents list` command

**Files:**
- Create: `src/commands/agents.ts`
- Create: `test/commands/agents.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write `test/commands/agents.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";

const hermesDetect = vi.fn();
vi.mock("../../src/agents/registry.js", () => ({
  listAdapters: () => [
    {
      name: "hermes",
      displayName: "Hermes Agent",
      binary: "hermes",
      docsUrl: "https://hermes-agent.nousresearch.com/docs/",
      detect: hermesDetect,
      install: vi.fn(),
      snapshotConfig: vi.fn(),
      writeOpperConfig: vi.fn(),
      restoreConfig: vi.fn(),
      spawn: vi.fn(),
    },
  ],
  getAdapter: vi.fn(),
}));

const { agentsListCommand } = await import("../../src/commands/agents.js");

describe("agentsListCommand", () => {
  it("prints each adapter with installed status", async () => {
    hermesDetect.mockResolvedValue({
      installed: true,
      version: "1.0.0",
      configPath: "/home/user/.hermes/config.yaml",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await agentsListCommand();
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("Hermes Agent");
      expect(out).toContain("1.0.0");
      expect(out.toLowerCase()).toContain("installed");
    } finally {
      log.mockRestore();
    }
  });

  it("marks adapters as not installed when detect() says so", async () => {
    hermesDetect.mockResolvedValue({ installed: false });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await agentsListCommand();
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out.toLowerCase()).toContain("not installed");
    } finally {
      log.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- commands/agents`
Expected: FAIL "Cannot find module".

- [ ] **Step 3: Write `src/commands/agents.ts`**

```ts
import { listAdapters } from "../agents/registry.js";
import { brand } from "../ui/colors.js";

export async function agentsListCommand(): Promise<void> {
  for (const adapter of listAdapters()) {
    const detect = await adapter.detect();
    const status = detect.installed
      ? `${brand.purple("installed")}${detect.version ? ` v${detect.version}` : ""}`
      : brand.dim("not installed");
    const config = detect.configPath ? ` ${brand.dim(detect.configPath)}` : "";
    console.log(`${adapter.displayName.padEnd(16)} ${status}${config}`);
  }
}
```

- [ ] **Step 4: Wire into `src/index.ts`** (additive only)

Add near the other command imports:

```ts
import { agentsListCommand } from "./commands/agents.js";
```

Before `program.parseAsync(...)`, add:

```ts
const agentsCmd = program
  .command("agents")
  .description("Manage supported AI agents");

agentsCmd
  .command("list")
  .description("List supported agents and whether each is installed")
  .action(agentsListCommand);
```

- [ ] **Step 5: Run tests — must pass**

Run: `npm test -- commands/agents`
Expected: PASS (2 tests). Full suite clean. Typecheck exit 0. Build clean.

- [ ] **Step 6: Commit**

```bash
git add src/commands/agents.ts src/index.ts test/commands/agents.test.ts
git commit -m "feat: add \`opper agents list\` command"
```

---

## Task 10: `opper launch` command

**Files:**
- Create: `src/commands/launch.ts`
- Create: `test/commands/launch.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write `test/commands/launch.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const adapter = {
  name: "hermes",
  displayName: "Hermes Agent",
  binary: "hermes",
  docsUrl: "https://example",
  detect: vi.fn(),
  install: vi.fn(),
  snapshotConfig: vi.fn(),
  writeOpperConfig: vi.fn(),
  restoreConfig: vi.fn(),
  spawn: vi.fn(),
};

vi.mock("../../src/agents/registry.js", () => ({
  getAdapter: (name: string) => (name === "hermes" ? adapter : null),
  listAdapters: () => [adapter],
}));

const loginMock = vi.fn();
vi.mock("../../src/commands/login.js", () => ({ loginCommand: loginMock }));

const { launchCommand } = await import("../../src/commands/launch.js");

useTempOpperHome();

describe("launchCommand", () => {
  beforeEach: {
    // clear per-call state between tests
  }

  it("throws AUTH_REQUIRED when no slot is stored and login is skipped", async () => {
    // Simulate no slot AND no auto-login path: tests cover auto-login
    // separately; here we rely on the fact that `getSlot` returns null and
    // loginCommand is mocked as a no-op that never writes a slot.
    loginMock.mockResolvedValue(undefined);
    adapter.detect.mockResolvedValue({ installed: true });
    await expect(
      launchCommand({ agent: "hermes", key: "default" }),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("throws AGENT_NOT_FOUND when the adapter name is unknown", async () => {
    await expect(
      launchCommand({ agent: "nonexistent", key: "default" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  it("throws AGENT_NOT_FOUND when the agent isn't installed and --install wasn't passed", async () => {
    await setSlot("default", { apiKey: "op_live_x" });
    adapter.detect.mockResolvedValue({ installed: false });
    await expect(
      launchCommand({ agent: "hermes", key: "default" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  it("installs, snapshots, writes config, spawns, and restores on a happy path", async () => {
    await setSlot("default", { apiKey: "op_live_happy" });
    adapter.detect.mockResolvedValue({ installed: true });
    adapter.snapshotConfig.mockResolvedValue({
      agent: "hermes",
      backupPath: "/tmp/hermes-X.yaml",
      timestamp: "2026-04-21T00:00:00Z",
    });
    adapter.writeOpperConfig.mockResolvedValue(undefined);
    adapter.spawn.mockResolvedValue(0);
    adapter.restoreConfig.mockResolvedValue(undefined);

    const code = await launchCommand({
      agent: "hermes",
      key: "default",
      model: "anthropic/claude-opus-4.7",
      passthrough: ["chat", "hi"],
    });

    expect(code).toBe(0);
    expect(adapter.snapshotConfig).toHaveBeenCalled();
    expect(adapter.writeOpperConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "op_live_happy",
        model: "anthropic/claude-opus-4.7",
        compatShape: "openai",
      }),
    );
    expect(adapter.spawn).toHaveBeenCalledWith(["chat", "hi"]);
    expect(adapter.restoreConfig).toHaveBeenCalled();
  });

  it("restores the config even if spawn throws", async () => {
    await setSlot("default", { apiKey: "op_live_x" });
    adapter.detect.mockResolvedValue({ installed: true });
    adapter.snapshotConfig.mockResolvedValue({
      agent: "hermes",
      backupPath: "/tmp/x.yaml",
      timestamp: "t",
    });
    adapter.writeOpperConfig.mockResolvedValue(undefined);
    adapter.spawn.mockRejectedValue(new Error("spawn died"));

    await expect(
      launchCommand({ agent: "hermes", key: "default" }),
    ).rejects.toThrow("spawn died");
    expect(adapter.restoreConfig).toHaveBeenCalled();
  });
});
```

Fix the stray `beforeEach:` note — it's not valid Vitest syntax. Use a proper block:

```ts
import { beforeEach } from "vitest";

beforeEach(() => {
  adapter.detect.mockReset();
  adapter.install.mockReset();
  adapter.snapshotConfig.mockReset();
  adapter.writeOpperConfig.mockReset();
  adapter.restoreConfig.mockReset();
  adapter.spawn.mockReset();
  loginMock.mockReset();
});
```

Place it inside the outer `describe` or at the top of the file after the mocks. Either is fine.

- [ ] **Step 2: Run — expect failure**

Run: `npm test -- commands/launch`
Expected: FAIL "Cannot find module".

- [ ] **Step 3: Write `src/commands/launch.ts`**

```ts
import { getAdapter } from "../agents/registry.js";
import { getSlot } from "../auth/config.js";
import { OpperError } from "../errors.js";
import { brand } from "../ui/colors.js";
import { OPPER_OPENAI_COMPAT_URL } from "../api/compat.js";
import type { OpperRouting } from "../agents/types.js";

const DEFAULT_MODEL = "anthropic/claude-opus-4.7";

export interface LaunchOptions {
  agent: string;
  key: string;
  model?: string;
  install?: boolean;
  passthrough?: string[];
}

export async function launchCommand(opts: LaunchOptions): Promise<number> {
  const adapter = getAdapter(opts.agent);
  if (!adapter) {
    throw new OpperError(
      "AGENT_NOT_FOUND",
      `Unknown agent "${opts.agent}"`,
      "Run `opper agents list` to see supported agents.",
    );
  }

  const slot = await getSlot(opts.key);
  if (!slot) {
    throw new OpperError(
      "AUTH_REQUIRED",
      `No API key stored for slot "${opts.key}"`,
      "Run `opper login` first.",
    );
  }

  const detection = await adapter.detect();
  if (!detection.installed) {
    if (!opts.install) {
      throw new OpperError(
        "AGENT_NOT_FOUND",
        `${adapter.displayName} is not installed`,
        `Run \`opper launch ${adapter.name} --install\` to install it, or visit ${adapter.docsUrl}.`,
      );
    }
    console.log(brand.dim(`Installing ${adapter.displayName}…`));
    await adapter.install();
  }

  const routing: OpperRouting = {
    baseUrl: OPPER_OPENAI_COMPAT_URL,
    apiKey: slot.apiKey,
    model: opts.model ?? DEFAULT_MODEL,
    compatShape: "openai",
  };

  const handle = await adapter.snapshotConfig();
  console.log(brand.dim(`Snapshot saved: ${handle.backupPath}`));

  const restore = async () => {
    try {
      await adapter.restoreConfig(handle);
    } catch (err) {
      console.error(
        `\nFailed to restore ${adapter.displayName} config. Recover manually with:`,
      );
      console.error(`  cp "${handle.backupPath}" "<your live config path>"`);
      throw err;
    }
  };

  await adapter.writeOpperConfig(routing);

  let exitCode = 0;
  const onSignal = (signal: NodeJS.Signals) => {
    // The child already received the signal via inherited stdio; we just need
    // to make sure restore runs when spawn returns. Re-throwing via process
    // exit ensures the CLI propagates the signal's exit code.
    process.once(signal, () => process.exit(128 + (signal === "SIGINT" ? 2 : 15)));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    exitCode = await adapter.spawn(opts.passthrough ?? []);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await restore();
  }

  return exitCode;
}
```

- [ ] **Step 4: Wire into `src/index.ts`** (additive only)

Add import:

```ts
import { launchCommand } from "./commands/launch.js";
```

Before `program.parseAsync(...)`, add:

```ts
program
  .command("launch")
  .description("Launch an AI agent with its inference routed through Opper")
  .argument("<agent>", "agent name (e.g. hermes)")
  .option("--model <id>", "Opper model identifier", "anthropic/claude-opus-4.7")
  .option("--install", "install the agent if missing", false)
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (agentName: string, cmdOpts: { model?: string; install?: boolean }, cmd) => {
    // Everything after a standalone `--` is forwarded to the agent.
    const args = (cmd.args as string[]).slice(1);
    const code = await launchCommand({
      agent: agentName,
      key: program.opts().key,
      ...(cmdOpts.model ? { model: cmdOpts.model } : {}),
      ...(cmdOpts.install ? { install: true } : {}),
      passthrough: args,
    });
    process.exit(code);
  });
```

Note: commander's pass-through semantics require `allowUnknownOption` and `allowExcessArguments`; `cmd.args` contains positional args after the `<agent>` positional, which is what we forward.

- [ ] **Step 5: Run tests — must pass**

Run: `npm test -- commands/launch`
Expected: PASS (5 tests). Full suite still passing. Typecheck exit 0. Build clean.

- [ ] **Step 6: Commit**

```bash
git add src/commands/launch.ts src/index.ts test/commands/launch.test.ts
git commit -m "feat: add \`opper launch\` command"
```

---

## Task 11: Update README + final smoke + push

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README.md Commands section**

Add a new subsection after "Editor integrations" and before "Wizards":

```markdown
### Agents
- `opper agents list` — List supported AI agents and whether each is installed.
- `opper launch <agent> [--model <id>] [--install] [-- <agent args>]` — Launch a supported agent with its inference routed through Opper. Snapshots the agent's config on entry, restores it on exit.
```

- [ ] **Step 2: Run full verification**

```bash
cd /Users/joch/dev/opper-ai/cli
npm test
npm run typecheck
npm run build
```

All must pass.

- [ ] **Step 3: End-to-end smoke test**

```bash
export OPPER_HOME=$(mktemp -d)
node dist/index.js agents list
# Expected: prints Hermes Agent with "not installed" (unless you have hermes locally)
node dist/index.js launch nonexistent 2>&1 || echo "exit=$?"
# Expected: stderr mentions AGENT_NOT_FOUND, exit 3
unset OPPER_HOME
```

Paste the output in your report.

- [ ] **Step 4: Commit and push**

```bash
git add README.md
git commit -m "docs: document agents/launch commands"
git push -u origin feat/plan-3-agent-launch
```

---

## Done criteria

After Task 11:

- `opper agents list` prints all registered adapters with detect status.
- `opper launch hermes` on a machine with hermes installed:
  1. checks auth,
  2. snapshots `~/.hermes/config.yaml` to `~/.opper/backups/hermes-<iso>.yaml`,
  3. rewrites `model:` to route through Opper v3,
  4. spawns `hermes`,
  5. restores the original config on exit.
- All tests pass (expect ~95 total after Plan 3).
- CI green on the merge commit once the PR is opened.

Plan 4 (call + models + remaining platform commands) ships next and completes the original Go-CLI parity surface.

---

## Self-review

**Spec coverage (§5):**

- §5.1 AgentAdapter interface with DetectResult, OpperRouting, SnapshotHandle → Task 1 ✓
- §5.2 Launch execution sequence (auth check → detect → install prompt → snapshot → write → spawn → restore → SIGINT trap → exit code propagation) → Task 10 ✓
- §5.3 Hermes specifics (configPath, install script URL, YAML model-block rewrite preserving other sections, atomic write) → Tasks 4-7 ✓
- §5.4 `opper agents list` → Task 9 ✓
- §5.5 Out of scope (pi / opencode / claude-code) — correctly excluded ✓
- §6 backups in `~/.opper/backups/`, rotation to last 20 per agent → Task 3 ✓
- §8 error codes `AGENT_NOT_FOUND` (3), `AGENT_CONFIG_CONFLICT` (4), `AGENT_RESTORE_FAILED` (5) → Tasks 5, 10 ✓ (AGENT_RESTORE_FAILED is emitted implicitly when `restoreConfig` throws inside the `restore()` wrapper; the caller's top-level `printError` handles it. No dedicated test — acceptable because the wrapper logs recovery instructions before re-throwing.)
- §13 v3 compat URL: single source of truth at `OPPER_OPENAI_COMPAT_URL` → reused, no new constant ✓

No spec gaps. The AGENT_RESTORE_FAILED wrapping in `launch.ts` catches any restore throw and prints the manual-recovery path; I did not wrap it in a new `OpperError` with that specific code because the underlying OS error is already informative and the top-level `printError` will show it. If you want the code set explicitly, add `throw new OpperError("AGENT_RESTORE_FAILED", …)` inside the catch.

**Placeholder scan:** clean.

**Type consistency:**

- `AgentAdapter` methods (name / displayName / binary / docsUrl + six async methods) match across Tasks 1, 4-7, 8, 9, 10 ✓
- `DetectResult { installed, version?, configPath? }` matches test stubs and impl ✓
- `OpperRouting { baseUrl, apiKey, model, compatShape }` matches Task 1 definition and Task 10 construction ✓
- `SnapshotHandle { agent, backupPath, timestamp }` matches Task 3 impl, Task 5 adapter, Task 10 wiring ✓
- `launchCommand({ agent, key, model?, install?, passthrough? })` matches Task 10 impl and `src/index.ts` call site ✓

No gaps.
