# Plan 2 of 4 — Setup Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `@opperai/setup` into the unified CLI so `opper skills` installs/updates Opper Skills, `opper editors` configures OpenCode and Continue.dev, and `opper setup` ties everything together as an interactive wizard.

**Architecture:** Plan 1 ships auth and the scaffold. Plan 2 adds three command groups on top: `skills` (delegates to `npx skills` via `spawnSync`), `editors` (writes editor config files from bundled templates), and `setup` (a `@clack/prompts` wizard that calls the underlying commands). Data templates ship as static assets under `data/`, read via `import.meta.url` at runtime. Shell commands use `spawnSync` with argv arrays — no `execSync(string)`, no shell metacharacter risk.

**Tech Stack:** Inherited from Plan 1 (TypeScript, Node ≥20.10, Vitest, commander, @clack/prompts, kleur, yaml). No new runtime deps.

**Depends on:** Plan 1 (scaffold + auth). Specifically `getSlot()` from `src/auth/config.js`, the OpperError class, the brand colors, and the commander entrypoint in `src/index.ts`.

**Spec:** `docs/superpowers/specs/2026-04-21-unified-opper-cli-design.md` — sections 3 (setup port file layout), 7 (command surface), 13 (v3 compat URL open item).

---

## Important scope decisions

- **API-key source of truth shifts from env var to config.** `@opperai/setup` read `process.env.OPPER_API_KEY`. In the new CLI, editor-config writers pull the key from `getSlot()` (Plan 1). Env var still works as an override, via `OPPER_API_KEY` (honored in a small helper).
- **`install.ts` from `@opperai/setup` is dropped.** It installed the legacy Go CLI via Homebrew. We *are* the CLI; that step becomes a no-op.
- **`apikey.ts` from `@opperai/setup` is dropped.** API key handling is now `opper login`. The wizard will offer "run `opper login` now?" if no slot exists instead of a password prompt.
- **OpenAI-compat base URL constant.** Spec §13 flags the exact v3 path as an open item. Plan 2 defines a single constant `OPPER_OPENAI_COMPAT_URL` at `src/api/compat.ts` so the value can be updated in one place when platform confirms. Seeded with `https://api.opper.ai/v3/openai` — confirm before publishing.
- **Shell execution.** We use `spawnSync("cmd", [args...])` everywhere, never `execSync("cmd args")`, so no shell metacharacter concerns even though our inputs are all hard-coded literals today.

---

## File Structure

Files created or modified in this plan:

| Path | Responsibility |
|---|---|
| `src/api/compat.ts` | `OPPER_OPENAI_COMPAT_URL` constant |
| `data/opencode.json` | Bundled OpenCode config template (copied from `@opperai/setup/data/opencode.json` with base URL swap) |
| `data/continue.yaml` | Bundled Continue.dev config template (same source) |
| `src/util/assets.ts` | Locates `data/` relative to the compiled file at runtime |
| `src/util/editor-paths.ts` | Editor config paths with `OPPER_EDITOR_HOME` test override |
| `src/util/run.ts` | Thin wrapper around `spawnSync` returning `{ code, stdout }` |
| `src/setup/skills.ts` | `installSkills()` / `updateSkills()` / `isSkillsInstalled()` |
| `src/setup/opencode.ts` | `configureOpenCode({ location })` |
| `src/setup/continue.ts` | `configureContinue({ location, apiKey })` |
| `src/setup/editors.ts` | `listEditors()` |
| `src/commands/skills.ts` | Wires `skills` subcommands into commander |
| `src/commands/editors.ts` | Wires `editors` subcommands into commander |
| `src/commands/setup.ts` | Wires the interactive `setup` wizard |
| `test/api/compat.test.ts` | |
| `test/util/assets.test.ts` | |
| `test/util/editor-paths.test.ts` | |
| `test/util/run.test.ts` | |
| `test/setup/skills.test.ts` | |
| `test/setup/opencode.test.ts` | |
| `test/setup/continue.test.ts` | |
| `test/setup/editors.test.ts` | |
| `test/commands/skills.test.ts` | |
| `test/commands/editors.test.ts` | |
| `test/commands/setup.test.ts` | Wizard flow test with prompt mocks |
| `package.json` | Add `data` to `files`; no new deps |
| `README.md` | Document the new commands |

Total: 13 tasks.

---

## Task 1: Add the compat URL constant

**Files:**
- Create: `src/api/compat.ts`
- Create: `test/api/compat.test.ts`

- [ ] **Step 1: Write `test/api/compat.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { OPPER_OPENAI_COMPAT_URL } from "../../src/api/compat.js";

describe("OPPER_OPENAI_COMPAT_URL", () => {
  it("is an https URL on api.opper.ai", () => {
    expect(OPPER_OPENAI_COMPAT_URL).toMatch(/^https:\/\/api\.opper\.ai\//);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- compat`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write `src/api/compat.ts`**

```ts
// Opper's OpenAI-compatible inference endpoint.
// TODO: spec §13 open item — confirm exact v3 path with the platform team
// before publishing. Update this one constant; all editor configs read it.
export const OPPER_OPENAI_COMPAT_URL = "https://api.opper.ai/v3/openai";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- compat`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/compat.ts test/api/compat.test.ts
git commit -m "feat: add OPPER_OPENAI_COMPAT_URL constant"
```

---

## Task 2: Ship OpenCode template as a bundled asset

**Files:**
- Create: `data/opencode.json` (copy from `@opperai/setup` with base URL swap)
- Create: `src/util/assets.ts`
- Create: `test/util/assets.test.ts`
- Modify: `package.json` (add `"data"` to `files`)

- [ ] **Step 1: Copy the template**

```bash
mkdir -p data
cp /Users/joch/dev/opper-ai/opper-setup/data/opencode.json data/opencode.json
```

Open `data/opencode.json` and replace every occurrence of `https://api.opper.ai/v2/openai` with `https://api.opper.ai/v3/openai` (matches `OPPER_OPENAI_COMPAT_URL`).

- [ ] **Step 2: Update `package.json` to ship `data/`**

Change the `files` array to:

```json
"files": ["dist", "data", "README.md", "LICENSE"]
```

- [ ] **Step 3: Write `test/util/assets.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { assetPath } from "../../src/util/assets.js";

describe("assetPath", () => {
  it("resolves the opencode template", () => {
    const path = assetPath("opencode.json");
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as { provider?: Record<string, unknown> };
    expect(parsed.provider).toBeDefined();
  });

  it("returns a path for an arbitrary asset name", () => {
    const path = assetPath("continue.yaml");
    expect(path).toMatch(/continue\.yaml$/);
  });
});
```

- [ ] **Step 4: Run test to verify the first assertion fails for the right reason**

Run: `npm test -- util/assets`
Expected: FAIL with "Cannot find module" (assets.ts not yet written).

- [ ] **Step 5: Write `src/util/assets.ts`**

```ts
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Resolves a path inside the bundled `data/` directory.
 *
 * Layout at runtime: `dist/util/assets.js` has `../../data/` next to it.
 * Same relative math works from `src/util/assets.ts` during tests since
 * `<repo>/data/` is also two levels up.
 */
export function assetPath(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "data", name);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- util/assets`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add data/opencode.json src/util/assets.ts test/util/assets.test.ts package.json
git commit -m "feat: ship OpenCode template as bundled asset"
```

---

## Task 3: Ship Continue.dev template as a bundled asset

**Files:**
- Create: `data/continue.yaml`

- [ ] **Step 1: Copy the template**

```bash
cp /Users/joch/dev/opper-ai/opper-setup/data/continue.yaml data/continue.yaml
```

Open `data/continue.yaml` and replace every `https://api.opper.ai/v2/openai` with `https://api.opper.ai/v3/openai`.

- [ ] **Step 2: Verify template parses**

Run:

```bash
node -e "const y=require('yaml').parse(require('fs').readFileSync('data/continue.yaml','utf8'));console.log(y.models.length)"
```

Expected: prints a number > 0.

- [ ] **Step 3: Commit**

```bash
git add data/continue.yaml
git commit -m "feat: ship Continue.dev template as bundled asset"
```

---

## Task 4: Add editor-paths helper

**Files:**
- Create: `src/util/editor-paths.ts`
- Create: `test/util/editor-paths.test.ts`

- [ ] **Step 1: Write `test/util/editor-paths.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  opencodeConfigPath,
  continueConfigPath,
} from "../../src/util/editor-paths.js";

describe("editor paths", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.OPPER_EDITOR_HOME;
    delete process.env.OPPER_EDITOR_HOME;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.OPPER_EDITOR_HOME;
    else process.env.OPPER_EDITOR_HOME = prev;
  });

  it("opencode global defaults to ~/.config/opencode/opencode.json", () => {
    expect(opencodeConfigPath("global")).toBe(
      join(homedir(), ".config", "opencode", "opencode.json"),
    );
  });

  it("opencode local defaults to cwd/opencode.json", () => {
    expect(opencodeConfigPath("local")).toBe(
      join(process.cwd(), "opencode.json"),
    );
  });

  it("continue global defaults to ~/.continue/config.yaml", () => {
    expect(continueConfigPath("global")).toBe(
      join(homedir(), ".continue", "config.yaml"),
    );
  });

  it("continue local defaults to cwd/.continue/config.yaml", () => {
    expect(continueConfigPath("local")).toBe(
      join(process.cwd(), ".continue", "config.yaml"),
    );
  });

  it("OPPER_EDITOR_HOME overrides the global home for both editors", () => {
    process.env.OPPER_EDITOR_HOME = "/tmp/fake";
    expect(opencodeConfigPath("global")).toBe(
      "/tmp/fake/.config/opencode/opencode.json",
    );
    expect(continueConfigPath("global")).toBe(
      "/tmp/fake/.continue/config.yaml",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- editor-paths`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write `src/util/editor-paths.ts`**

```ts
import { homedir } from "node:os";
import { join } from "node:path";

function home(): string {
  return process.env.OPPER_EDITOR_HOME ?? homedir();
}

export type Location = "global" | "local";

export function opencodeConfigPath(location: Location): string {
  return location === "global"
    ? join(home(), ".config", "opencode", "opencode.json")
    : join(process.cwd(), "opencode.json");
}

export function continueConfigPath(location: Location): string {
  return location === "global"
    ? join(home(), ".continue", "config.yaml")
    : join(process.cwd(), ".continue", "config.yaml");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- editor-paths`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/util/editor-paths.ts test/util/editor-paths.test.ts
git commit -m "feat: add editor config path helpers with test override"
```

---

## Task 5: Add a safe shell-out helper

**Files:**
- Create: `src/util/run.ts`
- Create: `test/util/run.test.ts`

Everything that shells out goes through this helper, which uses `spawnSync`
with an argv array — no shell metacharacters in any call site.

- [ ] **Step 1: Write `test/util/run.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { run } from "../../src/util/run.js";

describe("run", () => {
  it("captures stdout and exit code", () => {
    const result = run("node", ["-e", "process.stdout.write('hi');process.exit(0)"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hi");
  });

  it("reports non-zero exit codes", () => {
    const result = run("node", ["-e", "process.exit(3)"]);
    expect(result.code).toBe(3);
  });

  it("returns code -1 when the binary is missing", () => {
    const result = run("this-does-not-exist-12345", []);
    expect(result.code).toBe(-1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- util/run`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write `src/util/run.ts`**

```ts
import { spawnSync, type SpawnSyncOptions } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command with a fixed argv, no shell. Returns a structured result so
 * callers decide what to do with non-zero exits. Use `inherit: true` when you
 * want the child's stdout/stderr to go to the CLI's own streams (for
 * interactive installers).
 */
export function run(
  command: string,
  args: string[],
  options: { inherit?: boolean } & Pick<SpawnSyncOptions, "cwd" | "env"> = {},
): RunResult {
  const { inherit, ...rest } = options;
  const result = spawnSync(command, args, {
    ...rest,
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.error) {
    return { code: -1, stdout: "", stderr: result.error.message };
  }
  return {
    code: result.status ?? -1,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- util/run`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/util/run.ts test/util/run.test.ts
git commit -m "feat: add spawnSync-based run helper"
```

---

## Task 6: Port the OpenCode configuration writer

**Files:**
- Create: `src/setup/opencode.ts`
- Create: `test/setup/opencode.test.ts`

- [ ] **Step 1: Write `test/setup/opencode.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureOpenCode } from "../../src/setup/opencode.js";
import { opencodeConfigPath } from "../../src/util/editor-paths.js";

describe("configureOpenCode", () => {
  let home: string;
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.OPPER_EDITOR_HOME;
    home = mkdtempSync(join(tmpdir(), "opper-opencode-"));
    process.env.OPPER_EDITOR_HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (prev === undefined) delete process.env.OPPER_EDITOR_HOME;
    else process.env.OPPER_EDITOR_HOME = prev;
  });

  it("writes the template to the global location and creates the directory", async () => {
    const result = await configureOpenCode({ location: "global" });
    const expected = opencodeConfigPath("global");
    expect(result.path).toBe(expected);
    expect(result.wrote).toBe(true);
    expect(existsSync(expected)).toBe(true);
    const parsed = JSON.parse(readFileSync(expected, "utf8"));
    expect(parsed.provider).toBeDefined();
  });

  it("refuses to overwrite an existing Opper provider unless overwrite=true", async () => {
    const target = opencodeConfigPath("global");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      target,
      JSON.stringify({ provider: { opper: { existing: true } } }),
      "utf8",
    );

    const without = await configureOpenCode({ location: "global" });
    expect(without.wrote).toBe(false);
    expect(without.reason).toBe("exists");

    const withOverride = await configureOpenCode({
      location: "global",
      overwrite: true,
    });
    expect(withOverride.wrote).toBe(true);
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    expect(parsed.provider.opper.existing).toBeUndefined();
  });

  it("writes the template when existing config is unparseable", async () => {
    const target = opencodeConfigPath("global");
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(target, "{not json", "utf8");
    const result = await configureOpenCode({ location: "global" });
    expect(result.wrote).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- setup/opencode`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write `src/setup/opencode.ts`**

```ts
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { assetPath } from "../util/assets.js";
import { opencodeConfigPath, type Location } from "../util/editor-paths.js";

export interface ConfigureOpenCodeOptions {
  location: Location;
  /** If the destination already has an Opper provider, rewrite it. */
  overwrite?: boolean;
}

export interface ConfigureOpenCodeResult {
  path: string;
  wrote: boolean;
  reason?: "exists";
}

export async function configureOpenCode(
  opts: ConfigureOpenCodeOptions,
): Promise<ConfigureOpenCodeResult> {
  const path = opencodeConfigPath(opts.location);
  const template = readFileSync(assetPath("opencode.json"), "utf8");

  if (existsSync(path) && !opts.overwrite) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as {
        provider?: { opper?: unknown };
      };
      if (parsed.provider?.opper) {
        return { path, wrote: false, reason: "exists" };
      }
    } catch {
      // unparseable existing config — safe to overwrite
    }
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, template, "utf8");
  return { path, wrote: true };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- setup/opencode`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/setup/opencode.ts test/setup/opencode.test.ts
git commit -m "feat: port OpenCode setup from @opperai/setup"
```

---

## Task 7: Port the Continue.dev configuration writer

**Files:**
- Create: `src/setup/continue.ts`
- Create: `test/setup/continue.test.ts`

- [ ] **Step 1: Write `test/setup/continue.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { configureContinue } from "../../src/setup/continue.js";
import { continueConfigPath } from "../../src/util/editor-paths.js";
import { OPPER_OPENAI_COMPAT_URL } from "../../src/api/compat.js";

describe("configureContinue", () => {
  let home: string;
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.OPPER_EDITOR_HOME;
    home = mkdtempSync(join(tmpdir(), "opper-continue-"));
    process.env.OPPER_EDITOR_HOME = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (prev === undefined) delete process.env.OPPER_EDITOR_HOME;
    else process.env.OPPER_EDITOR_HOME = prev;
  });

  it("writes the template with apiKey injected into each model", async () => {
    const result = await configureContinue({
      location: "global",
      apiKey: "op_live_test",
    });
    expect(result.wrote).toBe(true);
    const content = readFileSync(continueConfigPath("global"), "utf8");
    const parsed = parse(content) as { models: Array<Record<string, unknown>> };
    expect(parsed.models.length).toBeGreaterThan(0);
    expect(parsed.models.every((m) => m.apiKey === "op_live_test")).toBe(true);
    expect(parsed.models.every((m) => m.apiBase === OPPER_OPENAI_COMPAT_URL)).toBe(true);
  });

  it("appends to existing non-Opper config", async () => {
    const target = continueConfigPath("global");
    mkdirSync(join(home, ".continue"), { recursive: true });
    writeFileSync(
      target,
      "models:\n  - name: local-llm\n    apiBase: http://localhost:1234\n",
      "utf8",
    );
    const result = await configureContinue({
      location: "global",
      apiKey: "op_live_x",
    });
    expect(result.wrote).toBe(true);
    const parsed = parse(readFileSync(target, "utf8")) as {
      models: Array<Record<string, unknown>>;
    };
    expect(parsed.models.some((m) => m.name === "local-llm")).toBe(true);
    expect(parsed.models.some((m) => m.apiBase === OPPER_OPENAI_COMPAT_URL)).toBe(true);
  });

  it("refuses to append duplicate Opper models unless overwrite=true", async () => {
    await configureContinue({ location: "global", apiKey: "op_live_1" });
    const result = await configureContinue({
      location: "global",
      apiKey: "op_live_2",
    });
    expect(result.wrote).toBe(false);
    expect(result.reason).toBe("exists");

    const forced = await configureContinue({
      location: "global",
      apiKey: "op_live_2",
      overwrite: true,
    });
    expect(forced.wrote).toBe(true);
    const parsed = parse(readFileSync(continueConfigPath("global"), "utf8")) as {
      models: Array<{ apiKey?: string; apiBase?: string }>;
    };
    const opperModels = parsed.models.filter(
      (m) => m.apiBase === OPPER_OPENAI_COMPAT_URL,
    );
    expect(opperModels.every((m) => m.apiKey === "op_live_2")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- setup/continue`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write `src/setup/continue.ts`**

```ts
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";
import { assetPath } from "../util/assets.js";
import { continueConfigPath, type Location } from "../util/editor-paths.js";
import { OPPER_OPENAI_COMPAT_URL } from "../api/compat.js";

export interface ConfigureContinueOptions {
  location: Location;
  apiKey: string;
  overwrite?: boolean;
}

export interface ConfigureContinueResult {
  path: string;
  wrote: boolean;
  reason?: "exists";
}

interface ContinueConfig {
  models?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

export async function configureContinue(
  opts: ConfigureContinueOptions,
): Promise<ConfigureContinueResult> {
  const path = continueConfigPath(opts.location);
  const template = parse(readFileSync(assetPath("continue.yaml"), "utf8")) as {
    models: Array<Record<string, unknown>>;
  };

  let existing: ContinueConfig = {};
  if (existsSync(path)) {
    try {
      existing = (parse(await readFile(path, "utf8")) as ContinueConfig) ?? {};
    } catch {
      existing = {};
    }
  }

  const existingModels = Array.isArray(existing.models) ? existing.models : [];
  const hasOpper = existingModels.some(
    (m) => (m as { apiBase?: unknown }).apiBase === OPPER_OPENAI_COMPAT_URL,
  );
  if (hasOpper && !opts.overwrite) {
    return { path, wrote: false, reason: "exists" };
  }

  const keptModels = existingModels.filter(
    (m) => (m as { apiBase?: unknown }).apiBase !== OPPER_OPENAI_COMPAT_URL,
  );
  const opperModels = template.models.map((m) => ({
    ...m,
    apiKey: opts.apiKey,
  }));

  existing.models = [...keptModels, ...opperModels];

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringify(existing), "utf8");
  return { path, wrote: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- setup/continue`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/setup/continue.ts test/setup/continue.test.ts
git commit -m "feat: port Continue.dev setup from @opperai/setup"
```

---

## Task 8: Port the skills installer

**Files:**
- Create: `src/setup/skills.ts`
- Create: `test/setup/skills.test.ts`

The skill commands shell out to `npx skills …`. We mock the `run` helper in
tests so they don't actually need `npx skills` installed.

- [ ] **Step 1: Write `test/setup/skills.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";

const runMock = vi.fn();
vi.mock("../../src/util/run.js", () => ({ run: runMock }));

const { isSkillsInstalled, installSkills, updateSkills } = await import(
  "../../src/setup/skills.js"
);

describe("skills", () => {
  it("isSkillsInstalled returns true when `npx skills list` mentions opper", () => {
    runMock.mockReturnValue({
      code: 0,
      stdout: "• opper-ai/opper-skills\n• other",
      stderr: "",
    });
    expect(isSkillsInstalled()).toBe(true);
    expect(runMock).toHaveBeenCalledWith("npx", ["skills", "list"]);
  });

  it("isSkillsInstalled returns false when no match", () => {
    runMock.mockReturnValue({ code: 0, stdout: "• foo\n• bar", stderr: "" });
    expect(isSkillsInstalled()).toBe(false);
  });

  it("isSkillsInstalled returns false when `npx skills` exits non-zero", () => {
    runMock.mockReturnValue({ code: 1, stdout: "", stderr: "no such command" });
    expect(isSkillsInstalled()).toBe(false);
  });

  it("installSkills runs `npx skills add opper-ai/opper-skills` with inherited stdio", async () => {
    runMock.mockClear();
    runMock.mockReturnValue({ code: 0, stdout: "", stderr: "" });
    await installSkills();
    expect(runMock).toHaveBeenCalledWith(
      "npx",
      ["skills", "add", "opper-ai/opper-skills"],
      { inherit: true },
    );
  });

  it("installSkills throws when the install fails", async () => {
    runMock.mockReturnValue({ code: 1, stdout: "", stderr: "boom" });
    await expect(installSkills()).rejects.toMatchObject({ code: "API_ERROR" });
  });

  it("updateSkills runs `npx skills update`", async () => {
    runMock.mockClear();
    runMock.mockReturnValue({ code: 0, stdout: "", stderr: "" });
    await updateSkills();
    expect(runMock).toHaveBeenCalledWith(
      "npx",
      ["skills", "update"],
      { inherit: true },
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- setup/skills`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write `src/setup/skills.ts`**

```ts
import { run } from "../util/run.js";
import { OpperError } from "../errors.js";

export function isSkillsInstalled(): boolean {
  const result = run("npx", ["skills", "list"]);
  if (result.code !== 0) return false;
  return result.stdout.toLowerCase().includes("opper");
}

export async function installSkills(): Promise<void> {
  const result = run("npx", ["skills", "add", "opper-ai/opper-skills"], {
    inherit: true,
  });
  if (result.code !== 0) {
    throw new OpperError(
      "API_ERROR",
      "Failed to install Opper skills",
      "Check that `npx skills` is available and try again.",
    );
  }
}

export async function updateSkills(): Promise<void> {
  const result = run("npx", ["skills", "update"], { inherit: true });
  if (result.code !== 0) {
    throw new OpperError(
      "API_ERROR",
      "Failed to update Opper skills",
      "Check that `npx skills` is available and try again.",
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- setup/skills`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/setup/skills.ts test/setup/skills.test.ts
git commit -m "feat: port skills install/update from @opperai/setup"
```

---

## Task 9: Add the supported-editors registry

**Files:**
- Create: `src/setup/editors.ts`
- Create: `test/setup/editors.test.ts`

- [ ] **Step 1: Write `test/setup/editors.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { listEditors } from "../../src/setup/editors.js";

describe("listEditors", () => {
  it("includes OpenCode and Continue with configure=true, others with configure=false", () => {
    const editors = listEditors();
    const opencode = editors.find((e) => e.id === "opencode");
    const continueDev = editors.find((e) => e.id === "continue");
    const cursor = editors.find((e) => e.id === "cursor");
    expect(opencode?.configure).toBe(true);
    expect(continueDev?.configure).toBe(true);
    expect(cursor?.configure).toBe(false);
    expect(cursor?.docsUrl).toMatch(/^https:\/\//);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- setup/editors`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write `src/setup/editors.ts`**

```ts
export interface Editor {
  id: "opencode" | "continue" | "cursor" | "windsurf" | "cline";
  displayName: string;
  /** True when the CLI can write config for this editor; false for docs-only. */
  configure: boolean;
  docsUrl: string;
}

const DOCS_URL = "https://docs.opper.ai/building/ai-editors";

export function listEditors(): Editor[] {
  return [
    { id: "opencode", displayName: "OpenCode", configure: true, docsUrl: DOCS_URL },
    { id: "continue", displayName: "Continue.dev", configure: true, docsUrl: DOCS_URL },
    { id: "cursor", displayName: "Cursor", configure: false, docsUrl: DOCS_URL },
    { id: "windsurf", displayName: "Windsurf", configure: false, docsUrl: DOCS_URL },
    { id: "cline", displayName: "Cline", configure: false, docsUrl: DOCS_URL },
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- setup/editors`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/setup/editors.ts test/setup/editors.test.ts
git commit -m "feat: add supported-editors registry"
```

---

## Task 10: Add `opper skills` command

**Files:**
- Create: `src/commands/skills.ts`
- Create: `test/commands/skills.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write `test/commands/skills.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";

const mocks = {
  isSkillsInstalled: vi.fn(),
  installSkills: vi.fn(),
  updateSkills: vi.fn(),
};

vi.mock("../../src/setup/skills.js", () => mocks);

const { skillsInstallCommand, skillsUpdateCommand, skillsListCommand } =
  await import("../../src/commands/skills.js");

describe("skills commands", () => {
  it("install calls installSkills when not already present", async () => {
    mocks.isSkillsInstalled.mockReturnValue(false);
    mocks.installSkills.mockClear();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await skillsInstallCommand();
      expect(mocks.installSkills).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("install short-circuits with a hint when already installed", async () => {
    mocks.isSkillsInstalled.mockReturnValue(true);
    mocks.installSkills.mockClear();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await skillsInstallCommand();
      expect(mocks.installSkills).not.toHaveBeenCalled();
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toMatch(/already/i);
    } finally {
      log.mockRestore();
    }
  });

  it("update calls updateSkills", async () => {
    mocks.updateSkills.mockClear();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await skillsUpdateCommand();
      expect(mocks.updateSkills).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("list prints whether Opper skills are installed", async () => {
    mocks.isSkillsInstalled.mockReturnValue(true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await skillsListCommand();
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toMatch(/installed/i);
    } finally {
      log.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- commands/skills`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write `src/commands/skills.ts`**

```ts
import { isSkillsInstalled, installSkills, updateSkills } from "../setup/skills.js";
import { brand } from "../ui/colors.js";

export async function skillsInstallCommand(): Promise<void> {
  if (isSkillsInstalled()) {
    console.log(
      `Opper skills already installed. Use ${brand.bold("opper skills update")} to refresh.`,
    );
    return;
  }
  await installSkills();
  console.log(brand.purple("✓ Opper skills installed."));
}

export async function skillsUpdateCommand(): Promise<void> {
  await updateSkills();
  console.log(brand.purple("✓ Opper skills updated."));
}

export async function skillsListCommand(): Promise<void> {
  if (isSkillsInstalled()) {
    console.log(`Opper skills: ${brand.purple("installed")}`);
  } else {
    console.log(
      `Opper skills: ${brand.dim("not installed")} — run ${brand.bold("opper skills install")}.`,
    );
  }
}
```

- [ ] **Step 4: Wire into `src/index.ts`**

Add:

```ts
import {
  skillsInstallCommand,
  skillsUpdateCommand,
  skillsListCommand,
} from "./commands/skills.js";

const skills = program.command("skills").description("Manage Opper skills");

skills
  .command("install")
  .description("Install Opper skills via `npx skills add opper-ai/opper-skills`")
  .action(skillsInstallCommand);

skills
  .command("update")
  .description("Update Opper skills to the latest version")
  .action(skillsUpdateCommand);

skills
  .command("list")
  .description("Show whether Opper skills are installed")
  .action(skillsListCommand);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- commands/skills`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/commands/skills.ts src/index.ts test/commands/skills.test.ts
git commit -m "feat: add `opper skills` command"
```

---

## Task 11: Add `opper editors` command

**Files:**
- Create: `src/commands/editors.ts`
- Create: `test/commands/editors.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write `test/commands/editors.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const mocks = {
  configureOpenCode: vi.fn(),
  configureContinue: vi.fn(),
};

vi.mock("../../src/setup/opencode.js", () => ({
  configureOpenCode: mocks.configureOpenCode,
}));
vi.mock("../../src/setup/continue.js", () => ({
  configureContinue: mocks.configureContinue,
}));

const {
  editorsListCommand,
  editorsOpenCodeCommand,
  editorsContinueCommand,
} = await import("../../src/commands/editors.js");

useTempOpperHome();

describe("editors commands", () => {
  it("list prints each editor with its capability", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await editorsListCommand();
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("OpenCode");
      expect(out).toContain("Continue.dev");
      expect(out).toContain("Cursor");
    } finally {
      log.mockRestore();
    }
  });

  it("opencode delegates to configureOpenCode with the chosen location", async () => {
    mocks.configureOpenCode.mockResolvedValue({
      path: "/tmp/opencode.json",
      wrote: true,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await editorsOpenCodeCommand({ location: "local", overwrite: false });
      expect(mocks.configureOpenCode).toHaveBeenCalledWith({ location: "local" });
    } finally {
      log.mockRestore();
    }
  });

  it("continue requires an authenticated slot for the API key", async () => {
    await expect(
      editorsContinueCommand({ location: "global", overwrite: false, key: "default" }),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("continue passes the slot apiKey to configureContinue", async () => {
    await setSlot("default", { apiKey: "op_live_xyz" });
    mocks.configureContinue.mockResolvedValue({
      path: "/tmp/cfg.yaml",
      wrote: true,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await editorsContinueCommand({ location: "global", overwrite: false, key: "default" });
      expect(mocks.configureContinue).toHaveBeenCalledWith({
        location: "global",
        apiKey: "op_live_xyz",
      });
    } finally {
      log.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- commands/editors`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write `src/commands/editors.ts`**

```ts
import { configureOpenCode } from "../setup/opencode.js";
import { configureContinue } from "../setup/continue.js";
import { listEditors } from "../setup/editors.js";
import { getSlot } from "../auth/config.js";
import { OpperError } from "../errors.js";
import { brand } from "../ui/colors.js";
import type { Location } from "../util/editor-paths.js";

export interface EditorsOpenCodeOptions {
  location: Location;
  overwrite: boolean;
}

export interface EditorsContinueOptions {
  location: Location;
  overwrite: boolean;
  key: string;
}

export async function editorsListCommand(): Promise<void> {
  for (const e of listEditors()) {
    const status = e.configure ? brand.purple("auto") : brand.dim("docs-only");
    console.log(`${e.displayName.padEnd(14)} ${status}  ${brand.dim(e.docsUrl)}`);
  }
}

export async function editorsOpenCodeCommand(
  opts: EditorsOpenCodeOptions,
): Promise<void> {
  const result = await configureOpenCode({ location: opts.location });
  if (!result.wrote && result.reason === "exists") {
    console.log(
      `OpenCode config at ${result.path} already has an Opper provider. Pass --overwrite to replace it.`,
    );
    return;
  }
  console.log(brand.purple(`✓ Wrote OpenCode config to ${result.path}.`));
}

export async function editorsContinueCommand(
  opts: EditorsContinueOptions,
): Promise<void> {
  const slot = await getSlot(opts.key);
  if (!slot) {
    throw new OpperError(
      "AUTH_REQUIRED",
      `No API key stored for slot "${opts.key}"`,
      "Run `opper login` first so Continue.dev can be configured with a key.",
    );
  }
  const result = await configureContinue({
    location: opts.location,
    apiKey: slot.apiKey,
  });
  if (!result.wrote && result.reason === "exists") {
    console.log(
      `Continue.dev config at ${result.path} already has Opper models. Pass --overwrite to replace them.`,
    );
    return;
  }
  console.log(brand.purple(`✓ Wrote Continue.dev config to ${result.path}.`));
}
```

- [ ] **Step 4: Wire into `src/index.ts`**

Add:

```ts
import {
  editorsListCommand,
  editorsOpenCodeCommand,
  editorsContinueCommand,
} from "./commands/editors.js";

const editors = program
  .command("editors")
  .description("Configure Opper in supported AI code editors");

editors
  .command("list")
  .description("List supported editors")
  .action(editorsListCommand);

editors
  .command("opencode")
  .description("Write the Opper provider block into OpenCode's config")
  .option("--global", "write to ~/.config/opencode/opencode.json", true)
  .option("--local", "write to ./opencode.json in the current directory")
  .option("--overwrite", "replace an existing Opper provider if present")
  .action(async (cmdOpts: { global?: boolean; local?: boolean; overwrite?: boolean }) => {
    await editorsOpenCodeCommand({
      location: cmdOpts.local ? "local" : "global",
      overwrite: cmdOpts.overwrite ?? false,
    });
  });

editors
  .command("continue")
  .description("Write Opper models into Continue.dev's config")
  .option("--global", "write to ~/.continue/config.yaml", true)
  .option("--local", "write to ./.continue/config.yaml")
  .option("--overwrite", "replace existing Opper models if present")
  .action(async (cmdOpts: { global?: boolean; local?: boolean; overwrite?: boolean }) => {
    await editorsContinueCommand({
      location: cmdOpts.local ? "local" : "global",
      overwrite: cmdOpts.overwrite ?? false,
      key: program.opts().key,
    });
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- commands/editors`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/commands/editors.ts src/index.ts test/commands/editors.test.ts
git commit -m "feat: add `opper editors` command"
```

---

## Task 12: Add `opper setup` wizard

**Files:**
- Create: `src/commands/setup.ts`
- Create: `test/commands/setup.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write `test/commands/setup.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const answers: Array<() => unknown> = [];

vi.mock("@clack/prompts", async () => {
  const actual = await vi.importActual<typeof import("@clack/prompts")>(
    "@clack/prompts",
  );
  return {
    ...actual,
    intro: vi.fn(),
    outro: vi.fn(),
    log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
    select: vi.fn(async () => answers.shift()?.() ?? "exit"),
    confirm: vi.fn(async () => answers.shift()?.() ?? false),
    isCancel: (v: unknown) => typeof v === "symbol",
    cancel: vi.fn(),
  };
});

const skillsMocks = {
  skillsInstallCommand: vi.fn(),
  skillsUpdateCommand: vi.fn(),
  skillsListCommand: vi.fn(),
};
vi.mock("../../src/commands/skills.js", () => skillsMocks);

const editorsMocks = {
  editorsListCommand: vi.fn(),
  editorsOpenCodeCommand: vi.fn(),
  editorsContinueCommand: vi.fn(),
};
vi.mock("../../src/commands/editors.js", () => editorsMocks);

const loginMock = vi.fn();
vi.mock("../../src/commands/login.js", () => ({ loginCommand: loginMock }));

const { setupCommand } = await import("../../src/commands/setup.js");

useTempOpperHome();

describe("setup wizard", () => {
  it("runs skills and opencode when the user picks them, then exits", async () => {
    await setSlot("default", { apiKey: "op_live_x" });
    answers.length = 0;
    answers.push(
      () => "skills",
      () => "opencode",
      () => "exit",
    );
    await setupCommand({ key: "default" });
    expect(skillsMocks.skillsInstallCommand).toHaveBeenCalled();
    expect(editorsMocks.editorsOpenCodeCommand).toHaveBeenCalled();
    expect(loginMock).not.toHaveBeenCalled();
  });

  it("runs login when there is no stored slot and the user agrees", async () => {
    answers.length = 0;
    answers.push(
      () => true,
      () => "exit",
    );
    await setupCommand({ key: "default" });
    expect(loginMock).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- commands/setup`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write `src/commands/setup.ts`**

```ts
import { intro, outro, select, confirm, log, isCancel, cancel } from "@clack/prompts";
import { getSlot } from "../auth/config.js";
import { loginCommand } from "./login.js";
import { skillsInstallCommand } from "./skills.js";
import {
  editorsOpenCodeCommand,
  editorsContinueCommand,
  editorsListCommand,
} from "./editors.js";
import { brand } from "../ui/colors.js";

export interface SetupOptions {
  key: string;
}

type TopChoice = "skills" | "opencode" | "continue" | "editors-list" | "exit";

function exitIfCancelled(value: unknown): void {
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    process.exit(0);
  }
}

export async function setupCommand(opts: SetupOptions): Promise<void> {
  intro(brand.purple("Opper Setup"));

  const slot = await getSlot(opts.key);
  if (!slot) {
    const wantsLogin = await confirm({
      message: "No API key stored. Run `opper login` now?",
      initialValue: true,
    });
    exitIfCancelled(wantsLogin);
    if (wantsLogin) {
      await loginCommand({ key: opts.key });
    } else {
      log.warn("Continuing without authentication. Some steps will be skipped.");
    }
  } else {
    log.success(`Already logged in as ${slot.user?.email ?? "(unknown)"}.`);
  }

  while (true) {
    const choice = (await select({
      message: "What would you like to set up?",
      options: [
        { value: "skills", label: "Install Opper skills" },
        { value: "opencode", label: "Configure OpenCode" },
        { value: "continue", label: "Configure Continue.dev" },
        { value: "editors-list", label: "List supported editors" },
        { value: "exit", label: "Exit" },
      ],
    })) as TopChoice;
    exitIfCancelled(choice);

    if (choice === "exit") break;

    try {
      if (choice === "skills") await skillsInstallCommand();
      else if (choice === "opencode") {
        await editorsOpenCodeCommand({ location: "global", overwrite: false });
      } else if (choice === "continue") {
        await editorsContinueCommand({
          location: "global",
          overwrite: false,
          key: opts.key,
        });
      } else if (choice === "editors-list") await editorsListCommand();
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
    }
  }

  outro(brand.purple("Done."));
}
```

- [ ] **Step 4: Wire into `src/index.ts`**

Add:

```ts
import { setupCommand } from "./commands/setup.js";

program
  .command("setup")
  .description("Run the interactive setup wizard")
  .action(async () => {
    await setupCommand({ key: program.opts().key });
  });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- commands/setup`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/commands/setup.ts src/index.ts test/commands/setup.test.ts
git commit -m "feat: add `opper setup` wizard"
```

---

## Task 13: Update README and final smoke test

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Expand README commands section**

Replace the Plan 1 "Commands" section with:

```markdown
## Commands

### Auth
- `opper login` — Authenticate via the OAuth device flow.
- `opper logout` — Clear stored credentials.
- `opper whoami` — Show the authenticated user for the active slot.

### Skills
- `opper skills install` — Install the Opper skill pack via `npx skills`.
- `opper skills update` — Update the installed skills.
- `opper skills list` — Show whether Opper skills are installed.

### Editor integrations
- `opper editors list` — List supported editors and which can be auto-configured.
- `opper editors opencode [--global|--local] [--overwrite]` — Write the Opper provider into OpenCode's config.
- `opper editors continue [--global|--local] [--overwrite]` — Write Opper models into Continue.dev's config.

### Wizards
- `opper setup` — Interactive wizard that ties the above together.

### Misc
- `opper version` — Print the CLI version.
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test && npm run typecheck && npm run build`
Expected: everything green.

- [ ] **Step 3: End-to-end smoke test**

```bash
export OPPER_HOME=$(mktemp -d)
export OPPER_EDITOR_HOME=$(mktemp -d)
node dist/index.js editors list
node dist/index.js skills list
unset OPPER_HOME OPPER_EDITOR_HOME
```

Expected: `editors list` prints all five editors; `skills list` prints installed/not-installed.

- [ ] **Step 4: Commit and push**

```bash
git add README.md
git commit -m "docs: document skills/editors/setup commands"
git push
```

Verify CI is green: `gh run watch`.

---

## Done criteria

After Task 13:

- `opper skills install|update|list` work against the real `npx skills` CLI.
- `opper editors opencode` writes `~/.config/opencode/opencode.json` with the Opper provider block.
- `opper editors continue` writes `~/.continue/config.yaml` with the current slot's API key injected into each model.
- `opper setup` runs the interactive wizard end-to-end.
- All tests pass with ≥80 % coverage across `src/`.
- CI green.

At this point, `opper` covers everything that was in `@opperai/setup` and can replace it. Plan 3 (agent launch) and Plan 4 (platform commands) build on the same foundation.

---

## Self-review

**Spec coverage:**

- §3 file layout — setup modules land under `src/setup/`, commands under `src/commands/`, data under `data/` ✓
- §7 `opper setup`, plus `opper skills` and `opper editors` subcommand trees — all delivered ✓
- §13 v3 compat URL open item — captured at a single constant with TODO pointing back to spec ✓

**Placeholder scan:** none; every step has exact code.

**Type consistency check:**

- `Location` type defined in Task 4 (`editor-paths.ts`), consumed unchanged in Tasks 6, 7, 11, 12 ✓
- `ConfigureOpenCodeResult` / `ConfigureContinueResult` shapes (`{ path, wrote, reason? }`) referenced identically in Task 11's command ✓
- `Editor` interface (`id`, `displayName`, `configure`, `docsUrl`) defined in Task 9, consumed in Task 11 ✓
- `RunResult` (`{ code, stdout, stderr }`) defined in Task 5, consumed in Task 8 ✓
- `AuthSlot` (from Plan 1) used in Task 11's `getSlot(opts.key)` and in the wizard in Task 12 ✓
- Wizard mocks in Task 12 reference the same command function names exported by Tasks 10 and 11 (`skillsInstallCommand`, `editorsOpenCodeCommand`, `editorsContinueCommand`, `editorsListCommand`) ✓

**Asset path sanity:** `assetPath()` math (`../../data/<name>` from the compiled file) assumes `src/util/assets.ts` → `dist/util/assets.js` at runtime and `<repo>/src/util/assets.ts` during tests. Both layouts have the same two-levels-up relationship to `data/`. Verified in Tasks 6 and 7 builds.

**Security:** all shell-outs go through `run()` with argv arrays, no shell strings. Tests mock `run` so they don't need `npx skills` installed.

No gaps found.
