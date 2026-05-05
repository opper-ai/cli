# Claude Desktop launch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `opper launch claude-desktop` and `opper agents uninstall <name>`, routing Claude Desktop's third-party-inference profile through Opper's compat gateway.

**Architecture:** New `claudeDesktop` adapter in `src/agents/claude-desktop.ts` implementing the existing `AgentAdapter` contract. Writes Claude Desktop's documented `deploymentMode: "3p"` profile (a `_meta.json` registry + a UUID-keyed gateway profile JSON) pointing at `OPPER_COMPAT_URL`. `spawn` writes the config, sends a quit via `osascript`/`powershell` if Claude is already running (5s poll timeout), then `open -a Claude` / `Start-Process`. macOS + Windows; Linux returns "not installed". A small new `agentsUninstallCommand` registers `opper agents uninstall <name>` so non-interactive removal exists for every adapter.

**Tech Stack:** TypeScript, Node 20, Vitest, Commander.js. All shell-outs go through the existing `src/util/run.ts` (`spawnSync` with fixed argv, no shell).

**Spec:** [`docs/superpowers/specs/2026-05-05-claude-desktop-launch.md`](../specs/2026-05-05-claude-desktop-launch.md)

---

## File map

**Create**
- `src/agents/claude-desktop.ts` — the adapter
- `test/agents/claude-desktop.test.ts` — adapter unit tests

**Modify**
- `src/agents/registry.ts` — append `claudeDesktop` to `ADAPTERS`
- `src/commands/agents.ts` — add `agentsUninstallCommand`
- `src/cli/agents.ts` — register `uninstall <name>` subcommand
- `test/agents/registry.test.ts` — assert `claude-desktop` is registered
- `test/commands/agents.test.ts` — assert `agentsUninstallCommand` calls `unconfigure` and rejects unknown names

---

## Task 1: Scaffold the adapter and register it

Creates a stub adapter that compiles, returns `installed: false` everywhere, and shows up in `opper agents list`. Subsequent tasks fill it in.

**Files:**
- Create: `src/agents/claude-desktop.ts`
- Modify: `src/agents/registry.ts`
- Modify: `test/agents/registry.test.ts`

- [ ] **Step 1: Write the failing registry test**

Append to `test/agents/registry.test.ts` after line 17 (before the closing brace):

```ts
  it("registers claude-desktop as a launchable adapter", async () => {
    const adapter = getAdapter("claude-desktop");
    expect(adapter).not.toBeNull();
    expect(adapter?.displayName).toBe("Claude Desktop");
    expect(typeof adapter?.spawn).toBe("function");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/agents/registry.test.ts`
Expected: FAIL with `expected null not to be null` (or similar) on the new test; existing tests still pass.

- [ ] **Step 3: Create the adapter stub**

Write `src/agents/claude-desktop.ts`:

```ts
import { OpperError } from "../errors.js";
import type {
  AgentAdapter,
  ConfigureOptions,
  DetectResult,
  OpperRouting,
} from "./types.js";

async function detect(): Promise<DetectResult> {
  return { installed: false };
}

async function isConfigured(): Promise<boolean> {
  return false;
}

async function configure(_opts: ConfigureOptions): Promise<void> {
  throw new OpperError("AGENT_NOT_FOUND", "claude-desktop adapter not yet implemented");
}

async function unconfigure(): Promise<void> {
  // Filled in by Task 6.
}

async function install(): Promise<void> {
  throw new OpperError(
    "AGENT_NOT_FOUND",
    "Claude Desktop must be installed manually.",
    "Download Claude Desktop from https://claude.ai/download.",
  );
}

async function spawn(_args: string[], _routing: OpperRouting): Promise<number> {
  throw new OpperError("AGENT_NOT_FOUND", "claude-desktop adapter not yet implemented");
}

export const claudeDesktop: AgentAdapter = {
  name: "claude-desktop",
  displayName: "Claude Desktop",
  docsUrl: "https://claude.ai/download",
  detect,
  isConfigured,
  configure,
  unconfigure,
  install,
  spawn,
};
```

- [ ] **Step 4: Register the adapter**

Modify `src/agents/registry.ts`:

```ts
import type { AgentAdapter } from "./types.js";
import { opencode } from "./opencode.js";
import { claudeCode } from "./claude-code.js";
import { claudeDesktop } from "./claude-desktop.js";
import { codex } from "./codex.js";
import { hermes } from "./hermes.js";
import { pi } from "./pi.js";
import { openclaw } from "./openclaw.js";

const ADAPTERS: ReadonlyArray<AgentAdapter> = [
  opencode,
  claudeCode,
  claudeDesktop,
  codex,
  hermes,
  pi,
  openclaw,
];

export function listAdapters(): ReadonlyArray<AgentAdapter> {
  return ADAPTERS;
}

export function getAdapter(name: string): AgentAdapter | null {
  return ADAPTERS.find((a) => a.name === name) ?? null;
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -- test/agents/registry.test.ts && npm run typecheck`
Expected: all tests pass; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/agents/claude-desktop.ts src/agents/registry.ts test/agents/registry.test.ts
git commit -m "feat(claude-desktop): scaffold adapter and register"
```

---

## Task 2: Implement `detect()` for macOS, Windows, and Linux

**Files:**
- Modify: `src/agents/claude-desktop.ts`
- Create: `test/agents/claude-desktop.test.ts`

- [ ] **Step 1: Write the failing detect tests**

Create `test/agents/claude-desktop.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const platformMock = vi.fn<[], NodeJS.Platform>(() => "darwin");
const homedirMock = vi.fn<[], string>(() => "/nonexistent");

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, platform: platformMock, homedir: homedirMock };
});

const { claudeDesktop } = await import("../../src/agents/claude-desktop.js");

function makeTempHome(): string {
  return mkdtempSync(join(tmpdir(), "opper-claude-desktop-"));
}

describe("claude-desktop adapter — detect", () => {
  let home: string;

  beforeEach(() => {
    platformMock.mockReturnValue("darwin");
    home = makeTempHome();
    homedirMock.mockReturnValue(home);
  });

  it("returns installed=false on linux regardless of fs state", async () => {
    platformMock.mockReturnValue("linux");
    expect((await claudeDesktop.detect()).installed).toBe(false);
  });

  it("darwin: returns installed=false when no Claude.app candidate exists", async () => {
    expect((await claudeDesktop.detect()).installed).toBe(false);
  });

  it("darwin: returns installed=true when /Applications/Claude.app exists", async () => {
    // The adapter checks /Applications/Claude.app first; we can't write
    // to it in CI, so verify the user-Applications fallback instead.
    mkdirSync(join(home, "Applications", "Claude.app"), { recursive: true });
    const result = await claudeDesktop.detect();
    expect(result.installed).toBe(true);
  });

  it("windows: returns installed=true when a known candidate exists", async () => {
    platformMock.mockReturnValue("win32");
    const local = join(home, "AppData", "Local");
    process.env.LOCALAPPDATA = local;
    mkdirSync(join(local, "AnthropicClaude"), { recursive: true });
    writeFileSync(join(local, "AnthropicClaude", "Claude.exe"), "");
    const result = await claudeDesktop.detect();
    expect(result.installed).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- test/agents/claude-desktop.test.ts`
Expected: FAIL — current `detect` always returns `{ installed: false }`, so the two `installed=true` tests fail.

- [ ] **Step 3: Implement detect()**

Replace the `detect` function in `src/agents/claude-desktop.ts` and add the imports / helpers above it. Full new content for the imports + helpers + `detect` block:

```ts
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { OpperError } from "../errors.js";
import type {
  AgentAdapter,
  ConfigureOptions,
  DetectResult,
  OpperRouting,
} from "./types.js";

function darwinAppCandidates(): string[] {
  return [
    "/Applications/Claude.app",
    join(homedir(), "Applications", "Claude.app"),
  ];
}

function windowsLocalAppData(): string | null {
  const local = (process.env.LOCALAPPDATA ?? "").trim();
  if (local) return local;
  const profile = (process.env.USERPROFILE ?? "").trim();
  if (profile) return join(profile, "AppData", "Local");
  try {
    return join(homedir(), "AppData", "Local");
  } catch {
    return null;
  }
}

function windowsAppCandidates(): string[] {
  const local = windowsLocalAppData();
  if (!local) return [];
  return [
    join(local, "Programs", "Claude", "Claude.exe"),
    join(local, "Programs", "Claude Desktop", "Claude.exe"),
    join(local, "Claude", "Claude.exe"),
    join(local, "Claude Nest", "Claude.exe"),
    join(local, "Claude Desktop", "Claude.exe"),
    join(local, "AnthropicClaude", "Claude.exe"),
  ];
}

function appCandidates(): string[] {
  switch (platform()) {
    case "darwin":
      return darwinAppCandidates();
    case "win32":
      return windowsAppCandidates();
    default:
      return [];
  }
}

async function detect(): Promise<DetectResult> {
  for (const candidate of appCandidates()) {
    if (existsSync(candidate)) return { installed: true };
  }
  return { installed: false };
}
```

Leave the rest of the file (configure / unconfigure / install / spawn / export) as in Task 1.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- test/agents/claude-desktop.test.ts && npm run typecheck`
Expected: all four detect tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/agents/claude-desktop.ts test/agents/claude-desktop.test.ts
git commit -m "feat(claude-desktop): implement detect for macOS, Windows, Linux"
```

---

## Task 3: Profile path helpers

Pure functions that resolve the macOS / Windows config paths. Unit-tested without filesystem effects.

**Files:**
- Modify: `src/agents/claude-desktop.ts`
- Modify: `test/agents/claude-desktop.test.ts`

- [ ] **Step 1: Write the failing path tests**

Append to `test/agents/claude-desktop.test.ts` inside the existing top-level imports section, expose the helpers via the adapter export. We'll test indirectly through `configure` / `isConfigured` rather than exporting helpers — keeps the public surface clean.

Append a new `describe` block to `test/agents/claude-desktop.test.ts`:

```ts
describe("claude-desktop adapter — paths (via isConfigured)", () => {
  let home: string;

  beforeEach(() => {
    platformMock.mockReturnValue("darwin");
    home = makeTempHome();
    homedirMock.mockReturnValue(home);
  });

  it("returns false when no config files exist (fresh tree)", async () => {
    expect(await claudeDesktop.isConfigured()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test -- test/agents/claude-desktop.test.ts`
Expected: PASS — current stub returns `false`. The test exists to lock in the contract before we touch `isConfigured`.

- [ ] **Step 3: Add path helpers to the adapter**

In `src/agents/claude-desktop.ts`, append below the `appCandidates` function (and before `detect`):

```ts
const OPPER_PROFILE_ID = "727f05c8-a429-43cc-b1c6-36d8883d98b8";
const OPPER_PROFILE_NAME = "Opper";

interface ThirdPartyPaths {
  desktopConfig: string;
  meta: string;
  profile: string;
}

interface ConfigTargets {
  normalConfigs: string[];
  thirdPartyProfiles: ThirdPartyPaths[];
}

function darwinProfileRoots(): { normal: string[]; thirdParty: string[] } {
  const base = join(homedir(), "Library", "Application Support");
  return {
    normal: [join(base, "Claude")],
    thirdParty: [join(base, "Claude-3p")],
  };
}

function windowsProfileRoots(): { normal: string[]; thirdParty: string[] } {
  const local = windowsLocalAppData();
  if (!local) return { normal: [], thirdParty: [] };
  return {
    normal: [join(local, "Claude"), join(local, "Claude Nest")],
    thirdParty: [join(local, "Claude-3p"), join(local, "Claude Nest-3p")],
  };
}

function profileRoots(): { normal: string[]; thirdParty: string[] } {
  switch (platform()) {
    case "darwin":
      return darwinProfileRoots();
    case "win32":
      return windowsProfileRoots();
    default:
      return { normal: [], thirdParty: [] };
  }
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function targetPaths(): ConfigTargets {
  const { normal, thirdParty } = profileRoots();
  return {
    normalConfigs: dedupePaths(normal).map((root) =>
      join(root, "claude_desktop_config.json"),
    ),
    thirdPartyProfiles: dedupePaths(thirdParty).map((root) => ({
      desktopConfig: join(root, "claude_desktop_config.json"),
      meta: join(root, "configLibrary", "_meta.json"),
      profile: join(root, "configLibrary", `${OPPER_PROFILE_ID}.json`),
    })),
  };
}
```

- [ ] **Step 4: Run tests + typecheck to verify nothing regressed**

Run: `npm test -- test/agents/claude-desktop.test.ts && npm run typecheck`
Expected: all tests pass; typecheck clean. The new helpers are unused so far — no behaviour change.

- [ ] **Step 5: Commit**

```bash
git add src/agents/claude-desktop.ts test/agents/claude-desktop.test.ts
git commit -m "feat(claude-desktop): add profile path helpers"
```

---

## Task 4: Implement `configure()` — write the three JSON files

**Files:**
- Modify: `src/agents/claude-desktop.ts`
- Modify: `test/agents/claude-desktop.test.ts`

- [ ] **Step 1: Write the failing configure tests**

Append to `test/agents/claude-desktop.test.ts`:

```ts
import { readFileSync as readFileSyncReal } from "node:fs";

describe("claude-desktop adapter — configure", () => {
  let home: string;

  beforeEach(() => {
    platformMock.mockReturnValue("darwin");
    home = makeTempHome();
    homedirMock.mockReturnValue(home);
  });

  function readJSON(path: string): any {
    return JSON.parse(readFileSyncReal(path, "utf8"));
  }

  it("throws AUTH_REQUIRED when called without an apiKey", async () => {
    await expect(claudeDesktop.configure({})).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });

  it("writes deploymentMode=3p to both normal and 3p config files", async () => {
    await claudeDesktop.configure({ apiKey: "op_test_key" });
    const base = join(home, "Library", "Application Support");
    expect(readJSON(join(base, "Claude", "claude_desktop_config.json"))).toMatchObject({
      deploymentMode: "3p",
    });
    expect(readJSON(join(base, "Claude-3p", "claude_desktop_config.json"))).toMatchObject({
      deploymentMode: "3p",
    });
  });

  it("writes the Opper entry into _meta.json and sets appliedId", async () => {
    await claudeDesktop.configure({ apiKey: "op_test_key" });
    const meta = readJSON(
      join(home, "Library", "Application Support", "Claude-3p", "configLibrary", "_meta.json"),
    );
    expect(meta.appliedId).toBe("727f05c8-a429-43cc-b1c6-36d8883d98b8");
    expect(meta.entries).toContainEqual({
      id: "727f05c8-a429-43cc-b1c6-36d8883d98b8",
      name: "Opper",
    });
  });

  it("writes the gateway profile JSON with Opper's compat URL and the api key", async () => {
    await claudeDesktop.configure({ apiKey: "op_test_key" });
    const profile = readJSON(
      join(
        home,
        "Library",
        "Application Support",
        "Claude-3p",
        "configLibrary",
        "727f05c8-a429-43cc-b1c6-36d8883d98b8.json",
      ),
    );
    expect(profile).toMatchObject({
      inferenceProvider: "gateway",
      inferenceGatewayBaseUrl: "https://api.opper.ai/v3/compat",
      inferenceGatewayApiKey: "op_test_key",
      inferenceGatewayAuthScheme: "bearer",
      disableDeploymentModeChooser: true,
    });
  });

  it("preserves user-owned siblings in the normal config and _meta.json", async () => {
    const base = join(home, "Library", "Application Support");
    const normalCfg = join(base, "Claude", "claude_desktop_config.json");
    mkdirSync(join(base, "Claude"), { recursive: true });
    writeFileSync(
      normalCfg,
      JSON.stringify({ mcpServers: { fs: { command: "fs" } } }, null, 2),
    );
    const metaPath = join(base, "Claude-3p", "configLibrary", "_meta.json");
    mkdirSync(join(base, "Claude-3p", "configLibrary"), { recursive: true });
    writeFileSync(
      metaPath,
      JSON.stringify({ entries: [{ id: "user-other", name: "Other" }] }, null, 2),
    );

    await claudeDesktop.configure({ apiKey: "op_test_key" });

    expect(readJSON(normalCfg)).toMatchObject({
      mcpServers: { fs: { command: "fs" } },
      deploymentMode: "3p",
    });
    const meta = readJSON(metaPath);
    expect(meta.entries).toContainEqual({ id: "user-other", name: "Other" });
    expect(meta.entries).toContainEqual({
      id: "727f05c8-a429-43cc-b1c6-36d8883d98b8",
      name: "Opper",
    });
  });

  it("is idempotent — running twice does not duplicate the Opper entry", async () => {
    await claudeDesktop.configure({ apiKey: "op_test_key" });
    await claudeDesktop.configure({ apiKey: "op_test_key" });
    const meta = readJSON(
      join(home, "Library", "Application Support", "Claude-3p", "configLibrary", "_meta.json"),
    );
    const opperEntries = (meta.entries as Array<{ id: string }>).filter(
      (e) => e.id === "727f05c8-a429-43cc-b1c6-36d8883d98b8",
    );
    expect(opperEntries).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- test/agents/claude-desktop.test.ts`
Expected: FAIL — `configure` currently throws `AGENT_NOT_FOUND`; we want `AUTH_REQUIRED` for the first test, and the rest expect file writes that don't happen.

- [ ] **Step 3: Implement configure()**

Add these imports at the top of `src/agents/claude-desktop.ts`:

```ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { OPPER_COMPAT_URL } from "../config/endpoints.js";
```

Add these helpers (above the existing `detect` function):

```ts
type JsonObject = Record<string, unknown>;

async function readJsonAllowMissing(path: string): Promise<JsonObject> {
  try {
    const data = await readFile(path, "utf8");
    const parsed = JSON.parse(data) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function writeJson(path: string, data: JsonObject): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function writeDeploymentMode(path: string, mode: "1p" | "3p"): Promise<void> {
  const cfg = await readJsonAllowMissing(path);
  cfg.deploymentMode = mode;
  await writeJson(path, cfg);
}

async function writeMetaWithOpperEntry(path: string): Promise<void> {
  const meta = await readJsonAllowMissing(path);
  meta.appliedId = OPPER_PROFILE_ID;
  const entries = Array.isArray(meta.entries) ? meta.entries : [];
  const filtered = entries.filter((e: unknown) => {
    const obj = e as { id?: unknown } | null;
    return !(obj && typeof obj === "object" && obj.id === OPPER_PROFILE_ID);
  });
  filtered.push({ id: OPPER_PROFILE_ID, name: OPPER_PROFILE_NAME });
  meta.entries = filtered;
  await writeJson(path, meta);
}

async function writeGatewayProfile(path: string, apiKey: string): Promise<void> {
  const cfg = await readJsonAllowMissing(path);
  cfg.inferenceProvider = "gateway";
  cfg.inferenceGatewayBaseUrl = OPPER_COMPAT_URL;
  cfg.inferenceGatewayApiKey = apiKey;
  cfg.inferenceGatewayAuthScheme = "bearer";
  cfg.disableDeploymentModeChooser = true;
  delete cfg.inferenceModels;
  await writeJson(path, cfg);
}
```

Replace the `configure` function with:

```ts
async function configure(opts: ConfigureOptions): Promise<void> {
  if (!opts.apiKey) {
    throw new OpperError(
      "AUTH_REQUIRED",
      "Claude Desktop configuration needs an Opper API key.",
      "Run `opper login` first, or set OPPER_API_KEY.",
    );
  }
  const targets = targetPaths();
  for (const path of targets.normalConfigs) {
    await writeDeploymentMode(path, "3p");
  }
  for (const target of targets.thirdPartyProfiles) {
    await writeDeploymentMode(target.desktopConfig, "3p");
    await writeMetaWithOpperEntry(target.meta);
    await writeGatewayProfile(target.profile, opts.apiKey);
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- test/agents/claude-desktop.test.ts && npm run typecheck`
Expected: all configure tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/agents/claude-desktop.ts test/agents/claude-desktop.test.ts
git commit -m "feat(claude-desktop): implement configure (write 3p profile)"
```

---

## Task 5: Implement `isConfigured()`

**Files:**
- Modify: `src/agents/claude-desktop.ts`
- Modify: `test/agents/claude-desktop.test.ts`

- [ ] **Step 1: Write the failing isConfigured tests**

Append to `test/agents/claude-desktop.test.ts`:

```ts
describe("claude-desktop adapter — isConfigured", () => {
  let home: string;

  beforeEach(() => {
    platformMock.mockReturnValue("darwin");
    home = makeTempHome();
    homedirMock.mockReturnValue(home);
  });

  it("returns false on a fresh tree", async () => {
    expect(await claudeDesktop.isConfigured()).toBe(false);
  });

  it("returns true after configure()", async () => {
    await claudeDesktop.configure({ apiKey: "op_test_key" });
    expect(await claudeDesktop.isConfigured()).toBe(true);
  });

  it("returns false when only the normal config is in 3p mode (incomplete)", async () => {
    const base = join(home, "Library", "Application Support");
    mkdirSync(join(base, "Claude"), { recursive: true });
    writeFileSync(
      join(base, "Claude", "claude_desktop_config.json"),
      JSON.stringify({ deploymentMode: "3p" }),
    );
    expect(await claudeDesktop.isConfigured()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- test/agents/claude-desktop.test.ts`
Expected: FAIL — current `isConfigured` always returns `false`, so the post-configure case fails.

- [ ] **Step 3: Implement isConfigured()**

Replace the `isConfigured` function in `src/agents/claude-desktop.ts`:

```ts
async function readJsonOrNull(path: string): Promise<JsonObject | null> {
  try {
    const data = await readFile(path, "utf8");
    const parsed = JSON.parse(data) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
    return null;
  } catch {
    return null;
  }
}

async function deploymentModeIsThirdParty(path: string): Promise<boolean> {
  const cfg = await readJsonOrNull(path);
  return cfg?.deploymentMode === "3p";
}

async function profileIsOpperGateway(target: ThirdPartyPaths): Promise<boolean> {
  const meta = await readJsonOrNull(target.meta);
  if (meta?.appliedId !== OPPER_PROFILE_ID) return false;
  const profile = await readJsonOrNull(target.profile);
  if (!profile) return false;
  if (profile.inferenceProvider !== "gateway") return false;
  const url = typeof profile.inferenceGatewayBaseUrl === "string"
    ? profile.inferenceGatewayBaseUrl.replace(/\/+$/, "")
    : "";
  if (url !== OPPER_COMPAT_URL.replace(/\/+$/, "")) return false;
  const key = typeof profile.inferenceGatewayApiKey === "string"
    ? profile.inferenceGatewayApiKey.trim()
    : "";
  return key.length > 0;
}

async function isConfigured(): Promise<boolean> {
  const targets = targetPaths();
  if (targets.normalConfigs.length === 0 || targets.thirdPartyProfiles.length === 0) {
    return false;
  }
  for (const path of targets.normalConfigs) {
    if (!(await deploymentModeIsThirdParty(path))) return false;
  }
  for (const target of targets.thirdPartyProfiles) {
    if (!(await deploymentModeIsThirdParty(target.desktopConfig))) return false;
    if (!(await profileIsOpperGateway(target))) return false;
  }
  return true;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- test/agents/claude-desktop.test.ts && npm run typecheck`
Expected: all tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/agents/claude-desktop.ts test/agents/claude-desktop.test.ts
git commit -m "feat(claude-desktop): implement isConfigured"
```

---

## Task 6: Implement `unconfigure()`

**Files:**
- Modify: `src/agents/claude-desktop.ts`
- Modify: `test/agents/claude-desktop.test.ts`

- [ ] **Step 1: Write the failing unconfigure tests**

Append to `test/agents/claude-desktop.test.ts`:

```ts
describe("claude-desktop adapter — unconfigure", () => {
  let home: string;

  beforeEach(() => {
    platformMock.mockReturnValue("darwin");
    home = makeTempHome();
    homedirMock.mockReturnValue(home);
  });

  function readJSON(path: string): any {
    return JSON.parse(readFileSyncReal(path, "utf8"));
  }

  it("is a no-op on a fresh tree (no errors, no writes)", async () => {
    await expect(claudeDesktop.unconfigure()).resolves.toBeUndefined();
  });

  it("flips deploymentMode back to 1p in both config files", async () => {
    await claudeDesktop.configure({ apiKey: "op_test_key" });
    await claudeDesktop.unconfigure();
    const base = join(home, "Library", "Application Support");
    expect(readJSON(join(base, "Claude", "claude_desktop_config.json"))).toMatchObject({
      deploymentMode: "1p",
    });
    expect(readJSON(join(base, "Claude-3p", "claude_desktop_config.json"))).toMatchObject({
      deploymentMode: "1p",
    });
  });

  it("removes the Opper entry from _meta.json and clears appliedId", async () => {
    await claudeDesktop.configure({ apiKey: "op_test_key" });
    await claudeDesktop.unconfigure();
    const meta = readJSON(
      join(home, "Library", "Application Support", "Claude-3p", "configLibrary", "_meta.json"),
    );
    expect(meta.appliedId).toBeUndefined();
    const opperEntries = (meta.entries as Array<{ id: string }>).filter(
      (e) => e.id === "727f05c8-a429-43cc-b1c6-36d8883d98b8",
    );
    expect(opperEntries).toHaveLength(0);
  });

  it("preserves user-owned _meta.json entries", async () => {
    const base = join(home, "Library", "Application Support");
    mkdirSync(join(base, "Claude-3p", "configLibrary"), { recursive: true });
    writeFileSync(
      join(base, "Claude-3p", "configLibrary", "_meta.json"),
      JSON.stringify({ entries: [{ id: "user-other", name: "Other" }] }),
    );
    await claudeDesktop.configure({ apiKey: "op_test_key" });
    await claudeDesktop.unconfigure();
    const meta = readJSON(
      join(base, "Claude-3p", "configLibrary", "_meta.json"),
    );
    expect(meta.entries).toContainEqual({ id: "user-other", name: "Other" });
  });

  it("blanks the gateway fields in the profile JSON", async () => {
    await claudeDesktop.configure({ apiKey: "op_test_key" });
    await claudeDesktop.unconfigure();
    const profile = readJSON(
      join(
        home,
        "Library",
        "Application Support",
        "Claude-3p",
        "configLibrary",
        "727f05c8-a429-43cc-b1c6-36d8883d98b8.json",
      ),
    );
    expect(profile.inferenceProvider).toBeUndefined();
    expect(profile.inferenceGatewayBaseUrl).toBeUndefined();
    expect(profile.inferenceGatewayApiKey).toBeUndefined();
    expect(profile.inferenceGatewayAuthScheme).toBeUndefined();
    expect(profile.disableDeploymentModeChooser).toBe(false);
  });

  it("isConfigured returns false after unconfigure", async () => {
    await claudeDesktop.configure({ apiKey: "op_test_key" });
    expect(await claudeDesktop.isConfigured()).toBe(true);
    await claudeDesktop.unconfigure();
    expect(await claudeDesktop.isConfigured()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- test/agents/claude-desktop.test.ts`
Expected: FAIL — `unconfigure` is a no-op stub.

- [ ] **Step 3: Implement unconfigure()**

Add helpers to `src/agents/claude-desktop.ts` (above the existing `unconfigure`):

```ts
async function clearOpperEntryFromMeta(path: string): Promise<void> {
  const meta = await readJsonOrNull(path);
  if (!meta) return;
  let changed = false;
  if (meta.appliedId === OPPER_PROFILE_ID) {
    delete meta.appliedId;
    changed = true;
  }
  if (Array.isArray(meta.entries)) {
    const filtered = meta.entries.filter((e: unknown) => {
      const obj = e as { id?: unknown } | null;
      return !(obj && typeof obj === "object" && obj.id === OPPER_PROFILE_ID);
    });
    if (filtered.length !== meta.entries.length) {
      meta.entries = filtered;
      changed = true;
    }
  }
  if (changed) await writeJson(path, meta);
}

async function blankGatewayProfile(path: string): Promise<void> {
  const cfg = await readJsonOrNull(path);
  if (!cfg) return;
  delete cfg.inferenceProvider;
  delete cfg.inferenceGatewayBaseUrl;
  delete cfg.inferenceGatewayApiKey;
  delete cfg.inferenceGatewayAuthScheme;
  delete cfg.inferenceModels;
  cfg.disableDeploymentModeChooser = false;
  await writeJson(path, cfg);
}

async function maybeFlipToFirstParty(path: string): Promise<void> {
  const cfg = await readJsonOrNull(path);
  if (!cfg) return;
  cfg.deploymentMode = "1p";
  await writeJson(path, cfg);
}
```

Replace the `unconfigure` function:

```ts
async function unconfigure(): Promise<void> {
  const targets = targetPaths();
  for (const path of targets.normalConfigs) {
    await maybeFlipToFirstParty(path);
  }
  for (const target of targets.thirdPartyProfiles) {
    await maybeFlipToFirstParty(target.desktopConfig);
    await clearOpperEntryFromMeta(target.meta);
    await blankGatewayProfile(target.profile);
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- test/agents/claude-desktop.test.ts && npm run typecheck`
Expected: all tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/agents/claude-desktop.ts test/agents/claude-desktop.test.ts
git commit -m "feat(claude-desktop): implement unconfigure"
```

---

## Task 7: `install()` and `spawn()` argument validation

**Files:**
- Modify: `src/agents/claude-desktop.ts`
- Modify: `test/agents/claude-desktop.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/agents/claude-desktop.test.ts`:

```ts
describe("claude-desktop adapter — install / spawn arg guards", () => {
  beforeEach(() => {
    platformMock.mockReturnValue("darwin");
    homedirMock.mockReturnValue(makeTempHome());
  });

  it("install throws AGENT_NOT_FOUND with the manual-install hint", async () => {
    await expect(claudeDesktop.install!()).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
      hint: expect.stringContaining("claude.ai/download"),
    });
  });

  it("spawn rejects passthrough arguments", async () => {
    const ROUTING = {
      baseUrl: "https://api.opper.ai/v3/compat",
      apiKey: "op_test_key",
      model: "claude-opus-4-7",
      compatShape: "openai" as const,
    };
    await expect(claudeDesktop.spawn!(["foo"], ROUTING)).rejects.toMatchObject({
      message: expect.stringContaining("does not accept"),
    });
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- test/agents/claude-desktop.test.ts`
Expected: FAIL — `install` is already implemented as expected (Task 1), but `spawn` still throws "not yet implemented" rather than "does not accept passthrough".

- [ ] **Step 3: Implement spawn arg guard (placeholder rest)**

Replace the `spawn` function in `src/agents/claude-desktop.ts`:

```ts
async function spawn(args: string[], routing: OpperRouting): Promise<number> {
  if (args.length > 0) {
    throw new OpperError(
      "AGENT_NOT_FOUND",
      "claude-desktop does not accept passthrough arguments.",
    );
  }
  await configure({ apiKey: routing.apiKey });
  // Quit + reopen logic added in Task 8.
  return 0;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- test/agents/claude-desktop.test.ts && npm run typecheck`
Expected: all tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/agents/claude-desktop.ts test/agents/claude-desktop.test.ts
git commit -m "feat(claude-desktop): install hint + spawn arg guard"
```

---

## Task 8: `spawn()` — quit-and-reopen flow

Wire up the actual app launch. We use `src/util/run.ts` (`spawnSync`-based, no shell, fixed argv) for every subprocess.

**Files:**
- Modify: `src/agents/claude-desktop.ts`
- Modify: `test/agents/claude-desktop.test.ts`

- [ ] **Step 1: Write the failing spawn tests**

At the **top** of `test/agents/claude-desktop.test.ts`, add a `run` mock alongside the existing `node:os` mock (insert after the `vi.mock("node:os", ...)` block):

```ts
const runMock = vi.fn<
  Parameters<typeof import("../../src/util/run.js")["run"]>,
  ReturnType<typeof import("../../src/util/run.js")["run"]>
>();
vi.mock("../../src/util/run.js", () => ({ run: runMock }));
```

Append a new `describe` block:

```ts
import type { RunResult } from "../../src/util/run.js";

function ok(stdout = ""): RunResult {
  return { code: 0, stdout, stderr: "" };
}

const ROUTING = {
  baseUrl: "https://api.opper.ai/v3/compat",
  apiKey: "op_test_key",
  model: "claude-opus-4-7",
  compatShape: "openai" as const,
};

describe("claude-desktop adapter — spawn (macOS)", () => {
  let home: string;

  beforeEach(() => {
    platformMock.mockReturnValue("darwin");
    home = makeTempHome();
    homedirMock.mockReturnValue(home);
    runMock.mockReset();
  });

  it("opens Claude when not already running", async () => {
    runMock.mockImplementation((cmd) => {
      if (cmd === "pgrep") return ok(""); // not running -> empty stdout
      return ok();
    });
    const code = await claudeDesktop.spawn!([], ROUTING);
    expect(code).toBe(0);

    // First call: detect running. Second call: open -a Claude.
    expect(runMock).toHaveBeenCalledWith(
      "pgrep",
      ["-f", "Claude.app/Contents/MacOS/Claude"],
    );
    expect(runMock).toHaveBeenCalledWith("open", ["-a", "Claude"]);
    // Should not have called osascript when not running.
    const osascriptCalls = runMock.mock.calls.filter((c) => c[0] === "osascript");
    expect(osascriptCalls).toHaveLength(0);
  });

  it("quits then reopens Claude when running, polling until exit", async () => {
    let pgrepCalls = 0;
    runMock.mockImplementation((cmd) => {
      if (cmd === "pgrep") {
        pgrepCalls += 1;
        // First two pgrep calls: running. Third: gone.
        return pgrepCalls < 3 ? ok("12345\n") : ok("");
      }
      return ok();
    });
    const code = await claudeDesktop.spawn!([], ROUTING);
    expect(code).toBe(0);

    expect(runMock).toHaveBeenCalledWith("osascript", [
      "-e",
      'tell application "Claude" to quit',
    ]);
    expect(runMock).toHaveBeenCalledWith("open", ["-a", "Claude"]);
    expect(pgrepCalls).toBeGreaterThanOrEqual(3);
  });

  it("errors when Claude fails to quit within the timeout", async () => {
    runMock.mockImplementation((cmd) => {
      if (cmd === "pgrep") return ok("12345\n"); // always running
      return ok();
    });
    await expect(claudeDesktop.spawn!([], ROUTING)).rejects.toMatchObject({
      message: expect.stringContaining("did not quit"),
    });
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- test/agents/claude-desktop.test.ts`
Expected: FAIL — `spawn` is currently a no-op after `configure`.

- [ ] **Step 3: Implement quit-and-reopen**

Add the `run` import at the top of `src/agents/claude-desktop.ts`:

```ts
import { run } from "../util/run.js";
```

Add these constants near the existing `OPPER_PROFILE_ID`:

```ts
const QUIT_TIMEOUT_MS = 5_000;
const QUIT_POLL_INTERVAL_MS = 200;
```

Add the helpers (above `spawn`):

```ts
function isClaudeRunning(): boolean {
  switch (platform()) {
    case "darwin": {
      const result = run("pgrep", ["-f", "Claude.app/Contents/MacOS/Claude"]);
      return result.code === 0 && result.stdout.trim().length > 0;
    }
    case "win32": {
      const result = run("powershell.exe", [
        "-NoProfile",
        "-Command",
        "(Get-Process claude -ErrorAction SilentlyContinue | " +
          "Where-Object { $_.MainWindowHandle -ne 0 } | " +
          "Select-Object -First 1).Id",
      ]);
      return result.code === 0 && result.stdout.trim().length > 0;
    }
    default:
      return false;
  }
}

function quitClaude(): void {
  switch (platform()) {
    case "darwin":
      run("osascript", ["-e", 'tell application "Claude" to quit']);
      return;
    case "win32":
      run("powershell.exe", [
        "-NoProfile",
        "-Command",
        "Get-Process claude -ErrorAction SilentlyContinue | " +
          "Where-Object { $_.MainWindowHandle -ne 0 } | " +
          "ForEach-Object { [void]$_.CloseMainWindow() }",
      ]);
      return;
  }
}

async function waitForClaudeExit(): Promise<boolean> {
  const deadline = Date.now() + QUIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isClaudeRunning()) return true;
    await new Promise((r) => setTimeout(r, QUIT_POLL_INTERVAL_MS));
  }
  return !isClaudeRunning();
}

function openClaude(): void {
  switch (platform()) {
    case "darwin":
      run("open", ["-a", "Claude"]);
      return;
    case "win32": {
      const exe = appCandidates().find((p) => existsSync(p));
      if (!exe) {
        throw new OpperError(
          "AGENT_NOT_FOUND",
          "Claude Desktop executable was not found.",
          "Open Claude Desktop manually once and re-run.",
        );
      }
      run("powershell.exe", [
        "-NoProfile",
        "-Command",
        `Start-Process -FilePath '${exe.replace(/'/g, "''")}'`,
      ]);
      return;
    }
  }
}
```

Replace the `spawn` function:

```ts
async function spawn(args: string[], routing: OpperRouting): Promise<number> {
  if (args.length > 0) {
    throw new OpperError(
      "AGENT_NOT_FOUND",
      "claude-desktop does not accept passthrough arguments.",
    );
  }
  await configure({ apiKey: routing.apiKey });

  if (isClaudeRunning()) {
    quitClaude();
    const exited = await waitForClaudeExit();
    if (!exited) {
      throw new OpperError(
        "AGENT_RESTORE_FAILED",
        "Claude Desktop did not quit within 5s.",
        "Quit Claude Desktop manually and re-run `opper launch claude-desktop`.",
      );
    }
  }
  openClaude();
  return 0;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- test/agents/claude-desktop.test.ts && npm run typecheck`
Expected: all spawn tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/agents/claude-desktop.ts test/agents/claude-desktop.test.ts
git commit -m "feat(claude-desktop): spawn opens or restarts Claude"
```

---

## Task 9: `opper agents uninstall <name>` CLI

Non-interactive companion to `opper launch <name>`.

**Files:**
- Modify: `src/commands/agents.ts`
- Modify: `src/cli/agents.ts`
- Modify: `test/commands/agents.test.ts`

- [ ] **Step 1: Write the failing command tests**

Append to `test/commands/agents.test.ts` (after the existing `agentsListCommand` describe):

```ts
const hermesUnconfigure = vi.fn();
const getAdapterMock = vi.mocked(
  (await import("../../src/agents/registry.js")).getAdapter,
);

describe("agentsUninstallCommand", () => {
  beforeEach(() => {
    hermesUnconfigure.mockReset();
    getAdapterMock.mockReset();
  });

  it("calls unconfigure on the resolved adapter", async () => {
    getAdapterMock.mockReturnValue({
      name: "hermes",
      displayName: "Hermes Agent",
      docsUrl: "https://example.com",
      detect: vi.fn(),
      isConfigured: vi.fn(),
      configure: vi.fn(),
      unconfigure: hermesUnconfigure,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { agentsUninstallCommand } = await import(
        "../../src/commands/agents.js"
      );
      await agentsUninstallCommand("hermes");
      expect(hermesUnconfigure).toHaveBeenCalled();
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("Hermes Agent");
      expect(out).toContain("removed");
    } finally {
      log.mockRestore();
    }
  });

  it("throws AGENT_NOT_FOUND for unknown adapter names", async () => {
    getAdapterMock.mockReturnValue(null);
    const { agentsUninstallCommand } = await import(
      "../../src/commands/agents.js"
    );
    await expect(agentsUninstallCommand("nope")).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- test/commands/agents.test.ts`
Expected: FAIL — `agentsUninstallCommand` doesn't exist yet (import error or runtime error).

- [ ] **Step 3: Implement agentsUninstallCommand**

Append to `src/commands/agents.ts` (below the existing `agentsListCommand`):

```ts
import { getAdapter } from "../agents/registry.js";
import { OpperError } from "../errors.js";

export async function agentsUninstallCommand(name: string): Promise<void> {
  const adapter = getAdapter(name);
  if (!adapter) {
    throw new OpperError(
      "AGENT_NOT_FOUND",
      `Unknown agent "${name}"`,
      "Run `opper agents list` to see supported agents.",
    );
  }
  await adapter.unconfigure();
  console.log(`${adapter.displayName} integration removed.`);
}
```

Note: there is already a `listAdapters` import at the top of `src/commands/agents.ts`. If `getAdapter` is not yet imported there, add it to the existing import line:

```ts
import { listAdapters, getAdapter } from "../agents/registry.js";
```

- [ ] **Step 4: Wire up the CLI subcommand**

Modify `src/cli/agents.ts` — replace the contents of the `register` function (after the `list` subcommand registration, before the `launch` registration):

```ts
import { agentsListCommand, agentsUninstallCommand } from "../commands/agents.js";
import { launchCommand } from "../commands/launch.js";
import type { RegisterFn } from "./types.js";

const register: RegisterFn = (program, ctx) => {
  const agentsCmd = program
    .command("agents")
    .description("Manage supported AI agents");

  agentsCmd
    .command("list")
    .description("List supported agents and whether each is installed")
    .action(agentsListCommand);

  agentsCmd
    .command("uninstall <name>")
    .description(
      "Remove the Opper integration from an agent's config (does not uninstall the agent itself)",
    )
    .action(async (name: string) => {
      await agentsUninstallCommand(name);
    });

  // ... rest of the existing launch registration unchanged
```

Keep the existing `program.command("launch")` block exactly as it is — only add the new `agentsCmd.command("uninstall <name>")` block above it.

- [ ] **Step 5: Run tests + typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/commands/agents.ts src/cli/agents.ts test/commands/agents.test.ts
git commit -m "feat(agents): add 'opper agents uninstall <name>' subcommand"
```

---

## Task 10: End-to-end smoke test on the local machine

This is a **manual** verification step before opening a PR. It exercises the real macOS code paths (file writes, `osascript`, `open -a`) which the unit tests mock.

**Pre-conditions:** You're on macOS with Claude Desktop installed and an Opper API key already logged in (`opper whoami` succeeds).

- [ ] **Step 1: Build and link the dev binary**

```bash
npm run build
node dist/index.js agents list
```

Expected: `claude-desktop` shows up in the table with `installed` status reflecting reality.

- [ ] **Step 2: Run launch (Claude Desktop closed)**

```bash
node dist/index.js launch claude-desktop
```

Expected:
- Claude Desktop launches.
- `~/Library/Application Support/Claude/claude_desktop_config.json` has `"deploymentMode": "3p"`.
- `~/Library/Application Support/Claude-3p/configLibrary/_meta.json` has `"appliedId": "727f05c8-..."`.
- `~/Library/Application Support/Claude-3p/configLibrary/727f05c8-....json` has `inferenceGatewayBaseUrl: "https://api.opper.ai/v3/compat"`.
- Claude Desktop's chat shows Opper-routed models in the picker.

Verify by sending a short message in Claude Desktop and watching `opper traces list` / `opper usage list` for activity.

- [ ] **Step 3: Run launch a second time (Claude Desktop open)**

```bash
node dist/index.js launch claude-desktop
```

Expected:
- macOS may prompt "opper would like to control Claude" the first time — accept.
- Claude Desktop quits and reopens within ~5 seconds.
- The second run is fully idempotent — no duplicate entries in `_meta.json`.

- [ ] **Step 4: Run uninstall**

```bash
node dist/index.js agents uninstall claude-desktop
```

Expected:
- "Claude Desktop integration removed." printed.
- `~/Library/Application Support/Claude/claude_desktop_config.json` now has `"deploymentMode": "1p"`.
- `_meta.json` no longer contains the Opper entry; `appliedId` is unset.
- Restart Claude Desktop manually — it's back on Anthropic inference.

- [ ] **Step 5: Re-run launch to confirm round-trip**

```bash
node dist/index.js launch claude-desktop
```

Expected: same outcome as Step 2 — clean re-configuration.

- [ ] **Step 6: Final lint, test, and typecheck**

```bash
npm run lint && npm test && npm run typecheck
```

Expected: all green.

- [ ] **Step 7: Open a PR**

Branch is already on `claude-desktop-support`. Push and open a PR:

```bash
git push -u origin claude-desktop-support
gh pr create --title "feat: add opper launch claude-desktop" --body "$(cat <<'EOF'
## Summary
- Adds `opper launch claude-desktop` — writes Claude Desktop's third-party-inference profile so its chat and Code surfaces both run through Opper's compat gateway. Mirrors `ollama launch claude-desktop`.
- Adds `opper agents uninstall <name>` — non-interactive companion to `opper launch <name>` so users can remove the integration without going through the menu.
- macOS + Windows. Linux returns "not installed" (Claude Desktop has no Linux build).

## Test plan
- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] Manual: `opper launch claude-desktop` configures and launches Claude Desktop on macOS
- [ ] Manual: re-running `opper launch claude-desktop` while it's open quits + reopens cleanly
- [ ] Manual: `opper agents uninstall claude-desktop` reverts deploymentMode back to "1p"
EOF
)"
```

Wait for codex to react with a thumbs-up on the PR description before merging (per project convention).

---

## Self-review checklist (already done)

- **Spec coverage:** every section of the spec maps to a task.
  - "Configuration mechanism" → Tasks 4 + 6.
  - "Architecture: detect" → Task 2.
  - "Architecture: isConfigured" → Task 5.
  - "Architecture: configure" → Task 4.
  - "Architecture: unconfigure" → Task 6.
  - "Architecture: install" → Task 7.
  - "Architecture: spawn" → Tasks 7 + 8.
  - "Modified registry.ts" → Task 1.
  - "New `opper agents uninstall <name>`" → Task 9.
  - "Error handling" → covered by argument-guard tests (Task 7), quit-timeout test (Task 8), and unknown-adapter test (Task 9).
  - "File atomicity" → not separately tested; node's `writeFile` is atomic-on-same-fs by contract.
  - "Constants & filesystem helpers" → constants live where Task 3 places them, helpers in Tasks 4–8.
- **Placeholder scan:** no TBD/TODO/"add error handling"/"similar to" placeholders.
- **Type consistency:** `OpperRouting`, `ConfigureOptions`, `DetectResult`, `AgentAdapter` come from `src/agents/types.ts`; `OPPER_PROFILE_ID` and `QUIT_TIMEOUT_MS` are referenced consistently across tasks.
- **Out of scope (per spec):** `--config`/`--restore`/`--yes` flags, pre-flight key validation, Linux support, backup files, session-summary tuning. None of these have plan tasks. Correct.
