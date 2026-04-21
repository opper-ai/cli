# Plan 1 of 4 — Scaffold + Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `opper` npm package with `login`, `logout`, `whoami`, `version` commands that authenticate via the OAuth device flow and persist the API key to `~/.opper/config.json`. After this plan, `npx opper login` works end-to-end against the Opper OAuth server.

**Architecture:** TypeScript → ESM, Node ≥20.10, commander for args, `@clack/prompts` for interactive UX, `@opperai/login` for the device flow. Config lives in `~/.opper/config.json` (file mode 0600). Tests use Vitest; filesystem tests use `mkdtempSync` with `OPPER_HOME` env override so no test touches the user's real `~`.

**Tech Stack:** TypeScript 5.x, Node 20.10+, Vitest, commander 12, @clack/prompts 1.x, @opperai/login 0.4+, kleur 4, yaml 2 (used by legacy-config migration), tsx (dev).

**Scope note:** Only commands listed above. Agent launch (Plan 2), setup port (Plan 3), call/models (Plan 4) build on the scaffold this plan produces. Telemetry is stubbed but not wired to an endpoint — spec §12 open item.

**Spec:** `docs/superpowers/specs/2026-04-21-unified-opper-cli-design.md` — sections 3, 4, 6, 7, 8, 10, 11 apply to this plan.

---

## File Structure

Files created in this plan:

| Path | Responsibility |
|---|---|
| `package.json` | npm metadata, `bin: { "opper": "dist/index.js" }`, scripts, deps |
| `tsconfig.json` | TS 5, ESM, Node16 module resolution, strict |
| `.gitignore` | node_modules, dist, coverage, etc. |
| `vitest.config.ts` | Vitest — node env, coverage threshold |
| `.github/workflows/ci.yml` | typecheck + lint + test on push/PR |
| `LICENSE` | MIT |
| `README.md` | User-facing intro |
| `src/index.ts` | bin entrypoint with shebang; commander setup; global flags; dispatches to commands |
| `src/errors.ts` | `OpperError` class + `EXIT_CODES` map |
| `src/ui/colors.ts` | Opper brand colors (port from `@opperai/setup`) |
| `src/ui/print.ts` | stderr formatter for `OpperError` and generic errors |
| `src/ui/prompts.ts` | thin wrapper over `@clack/prompts` with `isCancel` handling |
| `src/auth/paths.ts` | `opperHome()`, `configPath()`, `backupsDir()`, `legacyConfigPath()` |
| `src/auth/config.ts` | `readConfig`, `writeConfig`, `getSlot`, `setSlot`, `deleteSlot`, migration |
| `src/auth/device-flow.ts` | `runDeviceFlow(baseUrl?)` wraps `OpperLogin` |
| `src/commands/version.ts` | prints version from package.json |
| `src/commands/whoami.ts` | reads config, prints slot info |
| `src/commands/login.ts` | runs device flow, stores slot |
| `src/commands/logout.ts` | deletes slot(s) |
| `test/helpers/temp-home.ts` | `mkdtempSync` harness, sets `OPPER_HOME` in `beforeEach` |
| `test/auth/paths.test.ts` | paths module tests |
| `test/auth/config.test.ts` | config read/write/slot tests incl. migration |
| `test/auth/device-flow.test.ts` | device flow wrapper tests (SDK mocked) |
| `test/commands/version.test.ts` | version command test |
| `test/commands/whoami.test.ts` | whoami command test |
| `test/commands/login.test.ts` | login command test (device flow + config mocked) |
| `test/commands/logout.test.ts` | logout command test |

Total: 18 tasks. Each task = failing test → impl → passing test → commit.

---

## Task 1: Initialize npm package

**Files:**
- Create: `package.json`
- Create: `.gitignore`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "opper",
  "version": "0.1.0-pre.0",
  "description": "The official Opper CLI — authenticate, route agent inference, and manage the Opper platform",
  "type": "module",
  "bin": { "opper": "dist/index.js" },
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=20.10" },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "@clack/prompts": "^1.0.0",
    "@opperai/login": "^0.4.0",
    "commander": "^12.1.0",
    "kleur": "^4.1.5",
    "yaml": "^2.8.2"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/opper-ai/cli"
  },
  "license": "MIT",
  "keywords": ["opper", "cli", "ai", "llm"]
}
```

- [ ] **Step 2: Write `.gitignore`**

```
node_modules/
dist/
coverage/
*.log
.DS_Store
.env
.env.local
```

- [ ] **Step 3: Install deps**

Run: `cd /Users/joch/dev/opper-ai/cli && npm install`
Expected: installs without errors; `package-lock.json` created.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .gitignore
git commit -m "chore: initialize npm package"
```

---

## Task 2: Add TypeScript config

**Files:**
- Create: `tsconfig.json`
- Create: `src/index.ts` (placeholder)

- [ ] **Step 1: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 2: Write placeholder `src/index.ts`**

```ts
#!/usr/bin/env node
console.log("opper CLI — not yet implemented");
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 4: Run build and inspect output**

Run: `npm run build && ls dist/`
Expected: `dist/index.js` exists.

- [ ] **Step 5: Commit**

```bash
git add tsconfig.json src/index.ts
git commit -m "chore: add typescript config and entrypoint shell"
```

---

## Task 3: Add Vitest config and sample test

**Files:**
- Create: `vitest.config.ts`
- Create: `test/sanity.test.ts`

- [ ] **Step 1: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
});
```

- [ ] **Step 2: Write `test/sanity.test.ts`**

```ts
import { describe, it, expect } from "vitest";

describe("sanity", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: 1 test passes.

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts test/sanity.test.ts
git commit -m "chore: add vitest config and sanity test"
```

---

## Task 4: Add GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write `ci.yml`**

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20.10"
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

- [ ] **Step 2: Commit and push**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add typecheck + test + build workflow"
git push
```

- [ ] **Step 3: Verify workflow runs green**

Run: `gh run watch`
Expected: workflow passes on main.

---

## Task 5: Add OpperError class and exit codes

**Files:**
- Create: `src/errors.ts`
- Create: `test/errors.test.ts`

- [ ] **Step 1: Write `test/errors.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { OpperError, EXIT_CODES } from "../src/errors.js";

describe("OpperError", () => {
  it("carries code, message, and optional hint", () => {
    const e = new OpperError("AUTH_REQUIRED", "Not logged in", "Run opper login.");
    expect(e.code).toBe("AUTH_REQUIRED");
    expect(e.message).toBe("Not logged in");
    expect(e.hint).toBe("Run opper login.");
    expect(e.name).toBe("OpperError");
  });

  it("is an Error subclass", () => {
    const e = new OpperError("API_ERROR", "upstream");
    expect(e).toBeInstanceOf(Error);
  });
});

describe("EXIT_CODES", () => {
  it("maps every known code", () => {
    expect(EXIT_CODES.AUTH_REQUIRED).toBe(2);
    expect(EXIT_CODES.AUTH_EXPIRED).toBe(2);
    expect(EXIT_CODES.AGENT_NOT_FOUND).toBe(3);
    expect(EXIT_CODES.AGENT_CONFIG_CONFLICT).toBe(4);
    expect(EXIT_CODES.AGENT_RESTORE_FAILED).toBe(5);
    expect(EXIT_CODES.API_ERROR).toBe(6);
    expect(EXIT_CODES.NETWORK_ERROR).toBe(7);
    expect(EXIT_CODES.USER_CANCELLED).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- errors`
Expected: FAIL with "Cannot find module '../src/errors.js'".

- [ ] **Step 3: Write `src/errors.ts`**

```ts
export type OpperErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_EXPIRED"
  | "AGENT_NOT_FOUND"
  | "AGENT_CONFIG_CONFLICT"
  | "AGENT_RESTORE_FAILED"
  | "API_ERROR"
  | "NETWORK_ERROR"
  | "USER_CANCELLED";

export const EXIT_CODES: Record<OpperErrorCode, number> = {
  AUTH_REQUIRED: 2,
  AUTH_EXPIRED: 2,
  AGENT_NOT_FOUND: 3,
  AGENT_CONFIG_CONFLICT: 4,
  AGENT_RESTORE_FAILED: 5,
  API_ERROR: 6,
  NETWORK_ERROR: 7,
  USER_CANCELLED: 0,
};

export class OpperError extends Error {
  constructor(
    public readonly code: OpperErrorCode,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "OpperError";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- errors`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts test/errors.test.ts
git commit -m "feat: add OpperError and exit code table"
```

---

## Task 6: Add paths module

**Files:**
- Create: `src/auth/paths.ts`
- Create: `test/auth/paths.test.ts`

- [ ] **Step 1: Write `test/auth/paths.test.ts`**

```ts
import { afterEach, describe, it, expect, beforeEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  opperHome,
  configPath,
  backupsDir,
  legacyConfigPath,
} from "../../src/auth/paths.js";

describe("paths", () => {
  let origHome: string | undefined;

  beforeEach(() => {
    origHome = process.env.OPPER_HOME;
    delete process.env.OPPER_HOME;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.OPPER_HOME;
    else process.env.OPPER_HOME = origHome;
  });

  it("defaults opperHome() to ~/.opper", () => {
    expect(opperHome()).toBe(join(homedir(), ".opper"));
  });

  it("honours OPPER_HOME env override", () => {
    process.env.OPPER_HOME = "/tmp/fakehome";
    expect(opperHome()).toBe("/tmp/fakehome");
  });

  it("configPath() is opperHome()/config.json", () => {
    process.env.OPPER_HOME = "/tmp/fakehome";
    expect(configPath()).toBe("/tmp/fakehome/config.json");
  });

  it("backupsDir() is opperHome()/backups", () => {
    process.env.OPPER_HOME = "/tmp/fakehome";
    expect(backupsDir()).toBe("/tmp/fakehome/backups");
  });

  it("legacyConfigPath() is ~/.oppercli", () => {
    expect(legacyConfigPath()).toBe(join(homedir(), ".oppercli"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- paths`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write `src/auth/paths.ts`**

```ts
import { homedir } from "node:os";
import { join } from "node:path";

export function opperHome(): string {
  return process.env.OPPER_HOME ?? join(homedir(), ".opper");
}

export function configPath(): string {
  return join(opperHome(), "config.json");
}

export function backupsDir(): string {
  return join(opperHome(), "backups");
}

export function legacyConfigPath(): string {
  return join(homedir(), ".oppercli");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- paths`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/paths.ts test/auth/paths.test.ts
git commit -m "feat: add paths module with OPPER_HOME override"
```

---

## Task 7: Add temp-home test helper

**Files:**
- Create: `test/helpers/temp-home.ts`

- [ ] **Step 1: Write `test/helpers/temp-home.ts`**

```ts
import { afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates a fresh OPPER_HOME dir per test and cleans up after.
 * Returns a `get()` accessor so tests can read the current path.
 */
export function useTempOpperHome(): { get(): string } {
  let dir: string | null = null;
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.OPPER_HOME;
    dir = mkdtempSync(join(tmpdir(), "opper-test-"));
    process.env.OPPER_HOME = dir;
  });

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
    if (prev === undefined) delete process.env.OPPER_HOME;
    else process.env.OPPER_HOME = prev;
  });

  return {
    get() {
      if (!dir) throw new Error("useTempOpperHome() used outside a test");
      return dir;
    },
  };
}
```

- [ ] **Step 2: Commit (no test — this is test infra used by later tests)**

```bash
git add test/helpers/temp-home.ts
git commit -m "test: add OPPER_HOME temp-dir helper"
```

---

## Task 8: Add Config schema + read

**Files:**
- Create: `src/auth/config.ts`
- Create: `test/auth/config.test.ts`

- [ ] **Step 1: Write `test/auth/config.test.ts`** (read paths only — write comes in Task 9)

```ts
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { readConfig } from "../../src/auth/config.js";

const home = useTempOpperHome();

describe("readConfig", () => {
  it("returns null when no config exists", async () => {
    const result = await readConfig();
    expect(result).toBeNull();
  });

  it("parses a valid config", async () => {
    mkdirSync(home.get(), { recursive: true });
    writeFileSync(
      join(home.get(), "config.json"),
      JSON.stringify({
        version: 1,
        defaultKey: "default",
        keys: {
          default: { apiKey: "op_live_abc" },
        },
      }),
      "utf8",
    );
    const result = await readConfig();
    expect(result?.version).toBe(1);
    expect(result?.defaultKey).toBe("default");
    expect(result?.keys.default?.apiKey).toBe("op_live_abc");
  });

  it("throws OpperError on malformed JSON", async () => {
    mkdirSync(home.get(), { recursive: true });
    writeFileSync(join(home.get(), "config.json"), "{not json", "utf8");
    await expect(readConfig()).rejects.toMatchObject({ code: "API_ERROR" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- auth/config`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write `src/auth/config.ts`** (read-only portion)

```ts
import { readFile } from "node:fs/promises";
import { OpperError } from "../errors.js";
import { configPath } from "./paths.js";

export interface AuthSlot {
  apiKey: string;
  baseUrl?: string;
  user?: { email: string; name: string };
  obtainedAt?: string;
  source?: "device-flow" | "manual" | "migrated";
}

export interface Config {
  version: 1;
  defaultKey: string;
  keys: Record<string, AuthSlot>;
  telemetry?: {
    enabled: boolean;
    anonId?: string;
  };
}

export async function readConfig(): Promise<Config | null> {
  let raw: string;
  try {
    raw = await readFile(configPath(), "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as Config;
  } catch (err) {
    throw new OpperError(
      "API_ERROR",
      `Malformed config file at ${configPath()}`,
      "Delete the file or fix the JSON manually.",
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- auth/config`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/config.ts test/auth/config.test.ts
git commit -m "feat: add config read"
```

---

## Task 9: Add Config write + slot helpers

**Files:**
- Modify: `src/auth/config.ts`
- Modify: `test/auth/config.test.ts`

- [ ] **Step 1: Append tests to `test/auth/config.test.ts`**

Append inside the file (after the `describe("readConfig", …)` block):

```ts
import { statSync, existsSync } from "node:fs";
import {
  writeConfig,
  getSlot,
  setSlot,
  deleteSlot,
} from "../../src/auth/config.js";

describe("writeConfig", () => {
  it("writes JSON with mode 0600", async () => {
    await writeConfig({
      version: 1,
      defaultKey: "default",
      keys: { default: { apiKey: "op_live_x" } },
    });
    const path = join(home.get(), "config.json");
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("creates OPPER_HOME if missing", async () => {
    await writeConfig({
      version: 1,
      defaultKey: "default",
      keys: {},
    });
    expect(existsSync(home.get())).toBe(true);
  });
});

describe("slot helpers", () => {
  it("setSlot creates a config if none exists and sets defaultKey", async () => {
    await setSlot("default", { apiKey: "op_live_1" });
    const slot = await getSlot();
    expect(slot?.apiKey).toBe("op_live_1");
  });

  it("setSlot does not overwrite defaultKey if one exists", async () => {
    await setSlot("default", { apiKey: "op_live_1" });
    await setSlot("staging", { apiKey: "op_live_2" });
    const cfg = await readConfig();
    expect(cfg?.defaultKey).toBe("default");
    expect(cfg?.keys.staging?.apiKey).toBe("op_live_2");
  });

  it("getSlot returns null when slot missing", async () => {
    expect(await getSlot("missing")).toBeNull();
  });

  it("getSlot with no name uses defaultKey", async () => {
    await setSlot("prod", { apiKey: "op_live_p" });
    // prod becomes default because no config existed
    expect((await getSlot())?.apiKey).toBe("op_live_p");
  });

  it("deleteSlot removes a slot", async () => {
    await setSlot("default", { apiKey: "op_live_1" });
    await setSlot("staging", { apiKey: "op_live_2" });
    await deleteSlot("staging");
    const cfg = await readConfig();
    expect(cfg?.keys.staging).toBeUndefined();
    expect(cfg?.keys.default).toBeDefined();
  });

  it("deleteSlot is a no-op when slot missing", async () => {
    await expect(deleteSlot("nonexistent")).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- auth/config`
Expected: FAIL — `writeConfig`/`setSlot`/`getSlot`/`deleteSlot` not exported.

- [ ] **Step 3: Append to `src/auth/config.ts`**

```ts
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { opperHome } from "./paths.js";

export async function writeConfig(config: Config): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

function emptyConfig(): Config {
  return { version: 1, defaultKey: "default", keys: {} };
}

export async function getSlot(name?: string): Promise<AuthSlot | null> {
  const cfg = await readConfig();
  if (!cfg) return null;
  const key = name ?? cfg.defaultKey;
  return cfg.keys[key] ?? null;
}

export async function setSlot(name: string, slot: AuthSlot): Promise<void> {
  const cfg = (await readConfig()) ?? emptyConfig();
  const isFirstSlot = Object.keys(cfg.keys).length === 0;
  cfg.keys[name] = slot;
  if (isFirstSlot) cfg.defaultKey = name;
  await writeConfig(cfg);
}

export async function deleteSlot(name: string): Promise<void> {
  const cfg = await readConfig();
  if (!cfg || !(name in cfg.keys)) return;
  delete cfg.keys[name];
  if (cfg.defaultKey === name) {
    const remaining = Object.keys(cfg.keys);
    cfg.defaultKey = remaining[0] ?? "default";
  }
  await writeConfig(cfg);
}
```

Also add `opperHome` to imports at top:

```ts
import { configPath, opperHome } from "./paths.js";
```

(The `opperHome` import ensures paths.ts is traversable; `mkdir(dirname(path))` already covers directory creation.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- auth/config`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/auth/config.ts test/auth/config.test.ts
git commit -m "feat: add config write and slot helpers"
```

---

## Task 10: Add legacy ~/.oppercli migration

**Files:**
- Create: `src/auth/migrate.ts`
- Create: `test/auth/migrate.test.ts`

- [ ] **Step 1: Write `test/auth/migrate.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { maybeMigrateLegacyConfig } from "../../src/auth/migrate.js";
import { readConfig } from "../../src/auth/config.js";

const home = useTempOpperHome();

describe("maybeMigrateLegacyConfig", () => {
  it("does nothing when neither file exists", async () => {
    const migrated = await maybeMigrateLegacyConfig("/nonexistent/path");
    expect(migrated).toBe(false);
  });

  it("migrates a valid legacy file to the new schema", async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "opper-legacy-"));
    const legacyPath = join(legacyDir, ".oppercli");
    try {
      writeFileSync(
        legacyPath,
        [
          "api_keys:",
          "  default:",
          "    key: op_live_legacy",
          "    baseUrl: https://custom.example",
          "  staging:",
          "    key: op_live_stg",
        ].join("\n"),
        "utf8",
      );
      const migrated = await maybeMigrateLegacyConfig(legacyPath);
      expect(migrated).toBe(true);
      const cfg = await readConfig();
      expect(cfg?.defaultKey).toBe("default");
      expect(cfg?.keys.default?.apiKey).toBe("op_live_legacy");
      expect(cfg?.keys.default?.baseUrl).toBe("https://custom.example");
      expect(cfg?.keys.default?.source).toBe("migrated");
      expect(cfg?.keys.staging?.apiKey).toBe("op_live_stg");
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it("skips migration when new config already exists", async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "opper-legacy-"));
    const legacyPath = join(legacyDir, ".oppercli");
    try {
      // pre-create a new-format config
      const { writeConfig } = await import("../../src/auth/config.js");
      await writeConfig({
        version: 1,
        defaultKey: "default",
        keys: { default: { apiKey: "op_live_new" } },
      });
      writeFileSync(legacyPath, "api_keys:\n  default:\n    key: op_live_old\n", "utf8");
      const migrated = await maybeMigrateLegacyConfig(legacyPath);
      expect(migrated).toBe(false);
      const cfg = await readConfig();
      expect(cfg?.keys.default?.apiKey).toBe("op_live_new");
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- migrate`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write `src/auth/migrate.ts`**

```ts
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { writeConfig, type Config } from "./config.js";
import { configPath } from "./paths.js";
import { existsSync } from "node:fs";

interface LegacyFile {
  api_keys?: Record<
    string,
    { key?: string; baseUrl?: string }
  >;
}

export async function maybeMigrateLegacyConfig(legacyPath: string): Promise<boolean> {
  if (!existsSync(legacyPath)) return false;
  if (existsSync(configPath())) return false;

  let raw: string;
  try {
    raw = await readFile(legacyPath, "utf8");
  } catch {
    return false;
  }

  const parsed = parseYaml(raw) as LegacyFile | null;
  const keys = parsed?.api_keys;
  if (!keys || typeof keys !== "object") return false;

  const slots: Config["keys"] = {};
  for (const [name, entry] of Object.entries(keys)) {
    if (!entry?.key) continue;
    slots[name] = {
      apiKey: entry.key,
      ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
      source: "migrated",
    };
  }
  if (Object.keys(slots).length === 0) return false;

  const firstKey = Object.keys(slots)[0]!;
  const defaultKey = "default" in slots ? "default" : firstKey;

  await writeConfig({ version: 1, defaultKey, keys: slots });
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- migrate`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/migrate.ts test/auth/migrate.test.ts
git commit -m "feat: migrate legacy ~/.oppercli YAML config"
```

---

## Task 11: Add UI colors

**Files:**
- Create: `src/ui/colors.ts`
- Create: `test/ui/colors.test.ts`

- [ ] **Step 1: Write `test/ui/colors.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { brand } from "../../src/ui/colors.js";

describe("brand colors", () => {
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prev;
  });

  it("wraps text in ANSI escape codes by default", () => {
    const s = brand.purple("hi");
    expect(s).toMatch(/\x1b\[38;2;60;60;175m/);
    expect(s).toContain("hi");
    expect(s).toMatch(/\x1b\[0m$/);
  });

  it("returns plain text when NO_COLOR is set", () => {
    process.env.NO_COLOR = "1";
    expect(brand.purple("hi")).toBe("hi");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ui/colors`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write `src/ui/colors.ts`**

```ts
// Opper brand colors. Source: @opperai/setup src/index.ts.
// Using inline truecolor ANSI so we don't need to extend kleur.

function wrap(open: string, close = "\x1b[0m"): (s: string) => string {
  return (s: string) => {
    if (process.env.NO_COLOR) return s;
    return `${open}${s}${close}`;
  };
}

export const brand = {
  purple: wrap("\x1b[38;2;60;60;175m"),    // Savoy Purple #3C3CAF
  water: wrap("\x1b[38;2;140;240;220m"),   // Water Leaf #8CF0DC
  navy: wrap("\x1b[38;2;27;46;64m"),       // Blue Whale #1B2E40
  dim: wrap("\x1b[2m"),
  bold: wrap("\x1b[1m"),
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- ui/colors`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/colors.ts test/ui/colors.test.ts
git commit -m "feat: add Opper brand color helpers"
```

---

## Task 12: Add error printer

**Files:**
- Create: `src/ui/print.ts`
- Create: `test/ui/print.test.ts`

- [ ] **Step 1: Write `test/ui/print.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { OpperError } from "../../src/errors.js";
import { printError } from "../../src/ui/print.js";

describe("printError", () => {
  it("prints OpperError code, message, and hint to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      printError(
        new OpperError("AUTH_REQUIRED", "Not logged in", "Run opper login."),
      );
      const calls = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(calls).toContain("AUTH_REQUIRED");
      expect(calls).toContain("Not logged in");
      expect(calls).toContain("Run opper login.");
    } finally {
      spy.mockRestore();
    }
  });

  it("prints generic Error with just the message", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      printError(new Error("boom"));
      const calls = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(calls).toContain("boom");
      expect(calls).not.toContain("undefined");
    } finally {
      spy.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ui/print`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write `src/ui/print.ts`**

```ts
import { OpperError } from "../errors.js";
import { brand } from "./colors.js";

export function printError(err: unknown): void {
  if (err instanceof OpperError) {
    process.stderr.write(`${brand.bold("error")} [${err.code}]: ${err.message}\n`);
    if (err.hint) {
      process.stderr.write(`  ${brand.dim("hint:")} ${err.hint}\n`);
    }
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${brand.bold("error")}: ${msg}\n`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- ui/print`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/print.ts test/ui/print.test.ts
git commit -m "feat: add stderr error printer"
```

---

## Task 13: Add device flow wrapper

**Files:**
- Create: `src/auth/device-flow.ts`
- Create: `test/auth/device-flow.test.ts`

- [ ] **Step 1: Write `test/auth/device-flow.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";

// Mock @opperai/login before importing our wrapper.
const startDeviceAuth = vi.fn();
const pollDeviceToken = vi.fn();

vi.mock("@opperai/login", () => ({
  OpperLogin: vi.fn().mockImplementation(() => ({
    startDeviceAuth,
    pollDeviceToken,
  })),
}));

const { runDeviceFlow } = await import("../../src/auth/device-flow.js");

describe("runDeviceFlow", () => {
  beforeEach: {
    // no-op; vi.mock is hoisted
  }

  it("calls startDeviceAuth then pollDeviceToken with the result", async () => {
    startDeviceAuth.mockResolvedValue({
      deviceCode: "dc",
      userCode: "ABCD-1234",
      verificationUri: "https://platform.opper.ai/device",
      verificationUriComplete: "https://platform.opper.ai/device?user_code=ABCD-1234",
      expiresIn: 600,
      interval: 5,
    });
    pollDeviceToken.mockResolvedValue({
      apiKey: "op_live_abc",
      user: { email: "me@example.com", name: "Me" },
    });

    const onPrompt = vi.fn();
    const result = await runDeviceFlow({ onPrompt });

    expect(startDeviceAuth).toHaveBeenCalled();
    expect(pollDeviceToken).toHaveBeenCalledWith(
      expect.objectContaining({ userCode: "ABCD-1234" }),
    );
    expect(onPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ userCode: "ABCD-1234" }),
    );
    expect(result.apiKey).toBe("op_live_abc");
    expect(result.user).toEqual({ email: "me@example.com", name: "Me" });
    expect(result.source).toBe("device-flow");
    expect(typeof result.obtainedAt).toBe("string");
  });

  it("accepts a baseUrl override passed to OpperLogin", async () => {
    startDeviceAuth.mockResolvedValue({
      deviceCode: "dc",
      userCode: "x",
      verificationUri: "x",
      expiresIn: 600,
      interval: 5,
    });
    pollDeviceToken.mockResolvedValue({
      apiKey: "k",
      user: { email: "a", name: "b" },
    });
    const result = await runDeviceFlow({ baseUrl: "https://custom.example" });
    expect(result.baseUrl).toBe("https://custom.example");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- device-flow`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write `src/auth/device-flow.ts`**

```ts
import { OpperLogin } from "@opperai/login";
import type { AuthSlot } from "./config.js";

// Public OAuth client for the CLI. Provisioning flagged in spec §4.
const CLIENT_ID = "opper_app_cli";

export interface DevicePrompt {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
}

export interface RunDeviceFlowOptions {
  baseUrl?: string;
  onPrompt?: (p: DevicePrompt) => void;
}

export async function runDeviceFlow(
  opts: RunDeviceFlowOptions = {},
): Promise<AuthSlot> {
  const login = new OpperLogin({
    clientId: CLIENT_ID,
    ...(opts.baseUrl ? { opperUrl: opts.baseUrl } : {}),
  });

  const device = await login.startDeviceAuth();
  opts.onPrompt?.({
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    ...(device.verificationUriComplete
      ? { verificationUriComplete: device.verificationUriComplete }
      : {}),
    expiresIn: device.expiresIn,
  });

  const result = await login.pollDeviceToken(device);
  return {
    apiKey: result.apiKey,
    user: result.user,
    obtainedAt: new Date().toISOString(),
    source: "device-flow",
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- device-flow`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/device-flow.ts test/auth/device-flow.test.ts
git commit -m "feat: add device flow wrapper"
```

---

## Task 14: Wire up CLI entrypoint with commander

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Replace `src/index.ts` with commander scaffolding**

```ts
#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { OpperError, EXIT_CODES } from "./errors.js";
import { printError } from "./ui/print.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
) as { version: string };

const program = new Command();

program
  .name("opper")
  .description("The official Opper CLI")
  .version(pkg.version, "-v, --version")
  .option("--key <slot>", "API key slot to use", "default")
  .option("--debug", "enable debug output", false)
  .option("--no-telemetry", "disable anonymous telemetry")
  .option("--no-color", "disable ANSI colors");

program
  .command("version")
  .description("Print the CLI version")
  .action(() => {
    console.log(pkg.version);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  printError(err);
  const code = err instanceof OpperError ? EXIT_CODES[err.code] : 1;
  process.exit(code);
});
```

- [ ] **Step 2: Build and smoke-test**

Run: `npm run build && node dist/index.js version`
Expected: prints `0.1.0-pre.0`.

Run: `node dist/index.js --help`
Expected: help text listing `version` and global flags.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire up commander entrypoint with version command"
```

---

## Task 15: Add `whoami` command

**Files:**
- Create: `src/commands/whoami.ts`
- Create: `test/commands/whoami.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write `test/commands/whoami.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";
import { whoamiCommand } from "../../src/commands/whoami.js";

useTempOpperHome();

describe("whoami", () => {
  it("prints slot info when logged in", async () => {
    await setSlot("default", {
      apiKey: "op_live_abc123def456",
      user: { email: "me@example.com", name: "Me" },
      obtainedAt: "2026-04-21T11:00:00Z",
      source: "device-flow",
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await whoamiCommand({ key: "default" });
      const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("me@example.com");
      expect(out).toContain("Me");
      expect(out).toContain("default");
      expect(out).toContain("op_live_a"); // fingerprint prefix
      expect(out).not.toContain("op_live_abc123def456"); // full key hidden
    } finally {
      spy.mockRestore();
    }
  });

  it("throws AUTH_REQUIRED when slot missing", async () => {
    await expect(whoamiCommand({ key: "default" })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- whoami`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write `src/commands/whoami.ts`**

```ts
import { getSlot } from "../auth/config.js";
import { OpperError } from "../errors.js";
import { brand } from "../ui/colors.js";

export interface WhoamiOptions {
  key: string;
}

function fingerprint(apiKey: string): string {
  return apiKey.slice(0, 10) + "…";
}

export async function whoamiCommand(opts: WhoamiOptions): Promise<void> {
  const slot = await getSlot(opts.key);
  if (!slot) {
    throw new OpperError(
      "AUTH_REQUIRED",
      `No API key stored for slot "${opts.key}"`,
      "Run `opper login` to authenticate.",
    );
  }

  console.log(`${brand.bold("slot:")}    ${opts.key}`);
  if (slot.user) {
    console.log(`${brand.bold("user:")}    ${slot.user.name} <${slot.user.email}>`);
  }
  console.log(`${brand.bold("api key:")} ${fingerprint(slot.apiKey)}`);
  console.log(`${brand.bold("base url:")} ${slot.baseUrl ?? "https://api.opper.ai"}`);
  if (slot.obtainedAt) {
    console.log(`${brand.bold("since:")}   ${slot.obtainedAt}`);
  }
}
```

- [ ] **Step 4: Wire into `src/index.ts`**

Add after the `version` command registration:

```ts
import { whoamiCommand } from "./commands/whoami.js";

program
  .command("whoami")
  .description("Show the authenticated user for the active slot")
  .action(async () => {
    await whoamiCommand({ key: program.opts().key });
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- whoami`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/commands/whoami.ts src/index.ts test/commands/whoami.test.ts
git commit -m "feat: add whoami command"
```

---

## Task 16: Add `login` command

**Files:**
- Create: `src/commands/login.ts`
- Create: `test/commands/login.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write `test/commands/login.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { readConfig } from "../../src/auth/config.js";

// Mock device flow.
vi.mock("../../src/auth/device-flow.js", () => ({
  runDeviceFlow: vi.fn(),
}));

const { runDeviceFlow } = await import("../../src/auth/device-flow.js");
const { loginCommand } = await import("../../src/commands/login.js");

useTempOpperHome();

describe("login", () => {
  it("writes the slot returned by the device flow", async () => {
    vi.mocked(runDeviceFlow).mockResolvedValue({
      apiKey: "op_live_xyz",
      user: { email: "me@example.com", name: "Me" },
      obtainedAt: "2026-04-21T11:00:00Z",
      source: "device-flow",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await loginCommand({ key: "default" });
      const cfg = await readConfig();
      expect(cfg?.keys.default?.apiKey).toBe("op_live_xyz");
      expect(cfg?.keys.default?.user?.email).toBe("me@example.com");
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("me@example.com");
    } finally {
      log.mockRestore();
    }
  });

  it("short-circuits when slot already has a key", async () => {
    const { setSlot } = await import("../../src/auth/config.js");
    await setSlot("default", { apiKey: "op_live_existing" });
    vi.mocked(runDeviceFlow).mockClear();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await loginCommand({ key: "default" });
      expect(runDeviceFlow).not.toHaveBeenCalled();
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out.toLowerCase()).toContain("already");
    } finally {
      log.mockRestore();
    }
  });

  it("force flag re-runs the flow", async () => {
    const { setSlot } = await import("../../src/auth/config.js");
    await setSlot("default", { apiKey: "op_live_old" });
    vi.mocked(runDeviceFlow).mockClear();
    vi.mocked(runDeviceFlow).mockResolvedValue({
      apiKey: "op_live_new",
      user: { email: "me@example.com", name: "Me" },
      obtainedAt: "2026-04-21T11:00:00Z",
      source: "device-flow",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await loginCommand({ key: "default", force: true });
      expect(runDeviceFlow).toHaveBeenCalled();
      const cfg = await readConfig();
      expect(cfg?.keys.default?.apiKey).toBe("op_live_new");
    } finally {
      log.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- commands/login`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write `src/commands/login.ts`**

```ts
import { runDeviceFlow } from "../auth/device-flow.js";
import { getSlot, setSlot } from "../auth/config.js";
import { brand } from "../ui/colors.js";

export interface LoginOptions {
  key: string;
  baseUrl?: string;
  force?: boolean;
}

export async function loginCommand(opts: LoginOptions): Promise<void> {
  if (!opts.force) {
    const existing = await getSlot(opts.key);
    if (existing) {
      const who = existing.user ? ` as ${existing.user.email}` : "";
      console.log(`Already logged in${who}. Use --force to re-authenticate.`);
      return;
    }
  }

  const slot = await runDeviceFlow({
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    onPrompt(p) {
      const url = p.verificationUriComplete ?? p.verificationUri;
      console.log(`\n${brand.bold("Open this URL to sign in:")} ${brand.purple(url)}`);
      console.log(`${brand.bold("And enter the code:")} ${brand.water(p.userCode)}\n`);
      console.log(brand.dim("Waiting for authorization…"));
    },
  });

  await setSlot(opts.key, slot);
  const who = slot.user ? ` as ${slot.user.email}` : "";
  console.log(brand.purple(`✓ Logged in${who}.`));
}
```

- [ ] **Step 4: Wire into `src/index.ts`**

Add:

```ts
import { loginCommand } from "./commands/login.js";

program
  .command("login")
  .description("Authenticate with Opper via the OAuth device flow")
  .option("--force", "re-authenticate even if a key is already stored")
  .option("--base-url <url>", "override the Opper API base URL")
  .action(async (cmdOpts: { force?: boolean; baseUrl?: string }) => {
    await loginCommand({
      key: program.opts().key,
      ...(cmdOpts.baseUrl ? { baseUrl: cmdOpts.baseUrl } : {}),
      ...(cmdOpts.force ? { force: true } : {}),
    });
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- commands/login`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/commands/login.ts src/index.ts test/commands/login.test.ts
git commit -m "feat: add login command with device flow"
```

---

## Task 17: Add `logout` command

**Files:**
- Create: `src/commands/logout.ts`
- Create: `test/commands/logout.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write `test/commands/logout.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot, readConfig } from "../../src/auth/config.js";
import { logoutCommand } from "../../src/commands/logout.js";

useTempOpperHome();

describe("logout", () => {
  it("removes a single slot", async () => {
    await setSlot("default", { apiKey: "op_live_1" });
    await setSlot("staging", { apiKey: "op_live_2" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await logoutCommand({ key: "staging", all: false });
      const cfg = await readConfig();
      expect(cfg?.keys.staging).toBeUndefined();
      expect(cfg?.keys.default).toBeDefined();
    } finally {
      log.mockRestore();
    }
  });

  it("--all clears every slot", async () => {
    await setSlot("default", { apiKey: "op_live_1" });
    await setSlot("staging", { apiKey: "op_live_2" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await logoutCommand({ key: "default", all: true, yes: true });
      const cfg = await readConfig();
      expect(Object.keys(cfg?.keys ?? {})).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
  });

  it("reports when nothing to do", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await logoutCommand({ key: "default", all: false });
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out.toLowerCase()).toContain("nothing to log out");
    } finally {
      log.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- commands/logout`
Expected: FAIL.

- [ ] **Step 3: Write `src/commands/logout.ts`**

```ts
import { deleteSlot, readConfig, writeConfig } from "../auth/config.js";
import { brand } from "../ui/colors.js";

export interface LogoutOptions {
  key: string;
  all: boolean;
  yes?: boolean;
}

export async function logoutCommand(opts: LogoutOptions): Promise<void> {
  const cfg = await readConfig();
  if (!cfg || Object.keys(cfg.keys).length === 0) {
    console.log("Nothing to log out of.");
    return;
  }

  if (opts.all) {
    if (!opts.yes) {
      // Non-interactive environments must pass --yes. Callers from TTY should
      // wrap this with a @clack/prompts confirm(); for unit testing we keep
      // the command itself dependency-free.
      console.log("Pass --yes to confirm clearing every slot.");
      return;
    }
    await writeConfig({ ...cfg, keys: {}, defaultKey: "default" });
    console.log(brand.purple("✓ Logged out of all slots."));
    return;
  }

  if (!(opts.key in cfg.keys)) {
    console.log(`No slot named "${opts.key}" — nothing to do.`);
    return;
  }
  await deleteSlot(opts.key);
  console.log(brand.purple(`✓ Logged out of slot "${opts.key}".`));
}
```

- [ ] **Step 4: Wire into `src/index.ts`**

Add:

```ts
import { logoutCommand } from "./commands/logout.js";

program
  .command("logout")
  .description("Clear stored Opper credentials for a slot")
  .option("--all", "clear every slot", false)
  .option("--yes", "skip confirmation for --all", false)
  .action(async (cmdOpts: { all?: boolean; yes?: boolean }) => {
    await logoutCommand({
      key: program.opts().key,
      all: cmdOpts.all ?? false,
      ...(cmdOpts.yes ? { yes: true } : {}),
    });
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- commands/logout`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/commands/logout.ts src/index.ts test/commands/logout.test.ts
git commit -m "feat: add logout command"
```

---

## Task 18: Run legacy migration on first login and add README

**Files:**
- Modify: `src/commands/login.ts`
- Modify: `test/commands/login.test.ts`
- Create: `README.md`
- Create: `LICENSE`

- [ ] **Step 1: Add a migration-trigger test to `test/commands/login.test.ts`**

Append:

```ts
it("runs legacy migration before prompting if legacy file exists and new config missing", async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const legacyDir = mkdtempSync(join(tmpdir(), "opper-legacy-login-"));
  const legacyPath = join(legacyDir, ".oppercli");
  try {
    writeFileSync(
      legacyPath,
      "api_keys:\n  default:\n    key: op_live_legacy\n",
      "utf8",
    );
    vi.mocked(runDeviceFlow).mockClear();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await loginCommand({ key: "default", legacyPath });
      // Migration populated the slot — device flow should not run.
      expect(runDeviceFlow).not.toHaveBeenCalled();
      const cfg = await readConfig();
      expect(cfg?.keys.default?.apiKey).toBe("op_live_legacy");
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out.toLowerCase()).toContain("already");
    } finally {
      log.mockRestore();
    }
  } finally {
    rmSync(legacyDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Update `src/commands/login.ts` to run migration**

```ts
import { runDeviceFlow } from "../auth/device-flow.js";
import { getSlot, setSlot } from "../auth/config.js";
import { maybeMigrateLegacyConfig } from "../auth/migrate.js";
import { legacyConfigPath } from "../auth/paths.js";
import { brand } from "../ui/colors.js";

export interface LoginOptions {
  key: string;
  baseUrl?: string;
  force?: boolean;
  /** Override legacy file path (for tests). */
  legacyPath?: string;
}

export async function loginCommand(opts: LoginOptions): Promise<void> {
  if (!opts.force) {
    const migrated = await maybeMigrateLegacyConfig(
      opts.legacyPath ?? legacyConfigPath(),
    );
    if (migrated) {
      console.log(
        brand.dim(
          "Migrated legacy ~/.oppercli into ~/.opper/config.json (one-time).",
        ),
      );
    }
    const existing = await getSlot(opts.key);
    if (existing) {
      const who = existing.user ? ` as ${existing.user.email}` : "";
      console.log(`Already logged in${who}. Use --force to re-authenticate.`);
      return;
    }
  }

  const slot = await runDeviceFlow({
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    onPrompt(p) {
      const url = p.verificationUriComplete ?? p.verificationUri;
      console.log(`\n${brand.bold("Open this URL to sign in:")} ${brand.purple(url)}`);
      console.log(`${brand.bold("And enter the code:")} ${brand.water(p.userCode)}\n`);
      console.log(brand.dim("Waiting for authorization…"));
    },
  });

  await setSlot(opts.key, slot);
  const who = slot.user ? ` as ${slot.user.email}` : "";
  console.log(brand.purple(`✓ Logged in${who}.`));
}
```

- [ ] **Step 3: Write `README.md`**

```markdown
# opper

The official Opper CLI — authenticate, route agent inference, and manage the Opper platform.

## Quick start

```bash
npx opper login
npx opper whoami
```

## Install globally

```bash
npm i -g opper
opper --help
```

## Commands

- `opper login` — Authenticate via the OAuth device flow.
- `opper logout` — Clear stored credentials.
- `opper whoami` — Show the authenticated user for the active slot.
- `opper version` — Print the CLI version.

More commands (agent launch, setup wizard, call, models) are shipping soon.

## Requirements

- Node.js ≥20.10
```
```

- [ ] **Step 4: Write `LICENSE` (MIT)**

```
MIT License

Copyright (c) 2026 Opper AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all tests pass.

Run: `npm run typecheck && npm run build`
Expected: no errors.

- [ ] **Step 6: Smoke-test the built binary**

Run: `node dist/index.js whoami --key=default`
Expected: exits with code 2 and stderr contains `AUTH_REQUIRED` (no real config in dev).

- [ ] **Step 7: Commit**

```bash
git add src/commands/login.ts test/commands/login.test.ts README.md LICENSE
git commit -m "feat: run legacy migration on first login; add README + LICENSE"
```

---

## Done criteria

After Task 18:

- `npm test` green with ≥80 % coverage.
- `npm run typecheck` clean.
- `npm run build` produces a working `dist/index.js`.
- `node dist/index.js login` renders the device-flow prompt and, on approval, writes `~/.opper/config.json` with mode 0600.
- `node dist/index.js whoami` prints the slot or fails with `AUTH_REQUIRED` exit 2.
- `node dist/index.js logout` clears the slot.
- `node dist/index.js version` prints the package version.
- CI workflow is green on `main`.

At this point, the package is releasable as `0.1.0-pre.0` on npm for internal dogfooding. Plan 2 (agent launch) depends only on the scaffold this plan ships.

---

## Self-review

**Spec coverage for Plan 1 scope (§4, §6, §7 MVP subset, §8, §10, §11):**

- §4 device-flow login: Task 13, 16 ✓
- §4 CLI OAuth client: Task 13 (`CLIENT_ID = "opper_app_cli"`) with spec flag preserved ✓
- §4 whoami (offline): Task 15 ✓
- §4 logout with `--all`: Task 17 ✓
- §6 config schema + mode 0600: Task 9 ✓
- §6 legacy migration: Task 10, wired in Task 18 ✓
- §6 `OPPER_API_KEY` / `OPPER_BASE_URL` env overrides: **not yet** — these become relevant in Plan 4 (`call`) where the HTTP client reads them. No scaffolding needed in Plan 1.
- §7 `version`, `login`, `logout`, `whoami`: Tasks 14, 16, 17, 15 ✓
- §7 global flags `--key`, `--debug`, `--no-telemetry`, `--no-color`: Task 14 ✓ (`--debug` parsed but not wired yet — harmless until Plan 4)
- §8 OpperError + exit codes: Task 5, error printer Task 12, top-level wiring Task 14 ✓
- §10 Vitest + temp-dir harness: Tasks 3, 7 ✓
- §11 npm package + engines.node: Task 1 ✓
- §11 release workflow via OIDC: **deferred to end of Plan 2** — not needed until first public publish.

No gaps that block the MVP. Telemetry config field exists in the schema (Task 8) but ingestion endpoint is a spec-flagged open item and intentionally unwired.

**Placeholder scan:** None — every code step has the exact code.

**Type consistency check:**

- `AuthSlot` defined in Task 8, referenced with matching shape in Tasks 9, 13, 15, 16, 17 ✓
- `runDeviceFlow` signature `(opts: RunDeviceFlowOptions) => Promise<AuthSlot>` — matches call sites in Tasks 13 (test) and 16 (login) ✓
- `OpperError` constructor `(code, message, hint?)` — matches usage in Tasks 8, 12, 15 ✓
- `LoginOptions`/`LogoutOptions`/`WhoamiOptions` — each defined in its command file, only consumed by its own wiring in `src/index.ts` ✓
- `brand` helper exports `purple`, `water`, `navy`, `dim`, `bold` — matches Tasks 11, 12, 15, 16, 17, 18 ✓
