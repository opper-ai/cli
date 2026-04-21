# Unified Opper CLI — Design Spec

**Date:** 2026-04-21
**Status:** Draft — pending user review
**Repo:** `opper-ai/cli` (private during initial development)
**npm package:** `opper`
**Entry point:** `npx opper` / `opper`

## 1. Goal

Replace the legacy Go CLI (`opper-ai/oppercli`) and the standalone `@opperai/setup`
wizard with a single TypeScript CLI. The new CLI does three things:

1. Authenticates the user against Opper via the OAuth device flow and stores
   the resulting API key locally.
2. Routes any supported third-party AI agent's inference through Opper — the
   "Ollama-inspired" `opper launch <agent>` command that rewrites the agent's
   config file on entry and restores it on exit.
3. Administers the Opper platform from the terminal (`call`, `models`,
   `traces`, `usage`, `indexes`, `functions`, `image`), matching the Go CLI's
   surface.

Distribution is npm-first so `npx opper` runs on any machine with Node 20.10+.

## 2. Non-goals

- A Python CLI. There are SDKs for Python; the CLI is TypeScript only.
- An editor plug-in. `opper setup` writes editor configs; it does not ship
  extensions.
- Homebrew distribution in v1. The Go CLI's brew tap keeps working; a bottle
  may follow in phase 3.
- Feature-for-feature parity with the Go CLI on day one. See §9 for rollout.

## 3. Architecture

Single npm package, plain TypeScript compiled to ESM, no bundler.
Minimum Node 20.10 (native `fetch`, `node:test` available, still LTS).

```
cli/                              opper-ai/cli, private while we work on this
├── src/
│   ├── index.ts                  bin entrypoint — parses args, dispatches
│   ├── commands/
│   │   ├── login.ts
│   │   ├── logout.ts
│   │   ├── whoami.ts
│   │   ├── launch.ts
│   │   ├── agents.ts
│   │   ├── setup/                ported from @opperai/setup
│   │   │   ├── index.ts
│   │   │   ├── opencode.ts
│   │   │   ├── continue.ts
│   │   │   ├── skills.ts
│   │   │   ├── apikey.ts
│   │   │   └── install.ts
│   │   ├── call.ts
│   │   └── models.ts
│   ├── agents/
│   │   ├── types.ts              AgentAdapter interface
│   │   ├── hermes.ts             phase 1
│   │   └── registry.ts           name → adapter
│   ├── auth/
│   │   ├── device-flow.ts        wraps @opperai/login
│   │   └── config.ts             read/write ~/.opper/config.json
│   ├── api/
│   │   ├── client.ts             thin wrapper around @opperai/sdk + fetch
│   │   └── admin.ts              admin endpoints the SDK does not cover
│   ├── ui/                       kleur helpers, spinner, table output
│   └── util/                     fs helpers, yaml read/write, backup rotation
├── test/                         vitest
├── package.json
├── tsconfig.json
└── README.md
```

**Runtime dependencies (minimize for npx cold-start):**

| Package | Purpose |
|---|---|
| `@opperai/login` | OAuth device flow |
| `@opperai/sdk` (`opper-node`) | v3 data-plane calls |
| `commander` | arg parser |
| `@clack/prompts` | interactive wizard UX (matches `@opperai/setup`) |
| `kleur` | terminal colors |
| `yaml` | read/write YAML agent configs |

Target: compiled tarball under 500 KB.

## 4. Authentication flow

Device flow only (RFC 8628). Rationale: works over SSH, containers, and CI;
`@opperai/login` already implements it with proper `slow_down` and
`authorization_pending` handling. No local callback server, no PKCE state
juggling, no port conflicts.

`opper login`:
1. Read `~/.opper/config.json`. If a valid `apiKey` exists for the chosen
   `--key` slot, print "Already logged in as …" and exit 0.
2. Call `opper.startDeviceAuth()` → render user code + verification URL
   (prefer `verificationUriComplete` when the server returns it).
3. Optionally auto-open the browser (`open` / `xdg-open` / `start`). Skip on
   headless environments; detect via `process.stdout.isTTY`.
4. Call `opper.pollDeviceToken(device)` — the SDK handles back-off.
5. Write `{ apiKey, user, obtainedAt, source: "device-flow" }` into the config
   under the named slot. File mode 0600.
6. Print `Logged in as {email}` and exit.

`opper logout`: delete the API key for the named slot (default slot if
`--key` is not given). `--all` clears every slot after a confirmation prompt.
Does not call the server.

`opper whoami`: print email, name, slot name, base URL, and the short
fingerprint of the API key. Does not call the server either — offline-friendly.

### CLI OAuth client

Needs a public client ID registered on the Opper OAuth server for the CLI,
e.g. `opper_app_cli`. The CLI ships this client ID in the source code; no
`clientSecret`. This requires Opper's OAuth server to support public clients
(it already does — `@opperai/login` sends `client_secret` only when present).

**Open item to confirm with the platform team before launch:** provisioning
the `opper_app_cli` client ID and whether the device flow is enabled for it in
production.

## 5. Agent routing (`opper launch <agent>`)

### 5.1 Adapter interface

```ts
// src/agents/types.ts
export interface AgentAdapter {
  name: string;              // "hermes"
  displayName: string;
  binary: string;            // "hermes" — looked up on PATH
  docsUrl: string;

  detect(): Promise<DetectResult>;
  install(): Promise<void>;

  snapshotConfig(): Promise<SnapshotHandle>;
  writeOpperConfig(c: OpperRouting): Promise<void>;
  restoreConfig(handle: SnapshotHandle): Promise<void>;

  spawn(args: string[]): Promise<number>;
}

export interface DetectResult {
  installed: boolean;
  version?: string;
  configPath?: string;
}

export interface OpperRouting {
  baseUrl: string;         // e.g. https://api.opper.ai/v3
  apiKey: string;
  model: string;           // e.g. "anthropic/claude-opus-4.7"
  compatShape: "openai" | "anthropic" | "responses";
}

export interface SnapshotHandle {
  agent: string;
  backupPath: string;      // ~/.opper/backups/hermes-<iso>.yaml
  timestamp: string;
}
```

### 5.2 Launch execution

`opper launch hermes [-- <args passed to hermes>]`:

1. Auth check: if no active API key, run the `login` command inline.
2. `adapter.detect()`. If not installed: prompt, `adapter.install()` on yes,
   abort on no.
3. `adapter.snapshotConfig()` → writes a copy of the live config to
   `~/.opper/backups/hermes-<iso>.yaml` and returns a `SnapshotHandle`.
4. `adapter.writeOpperConfig({ baseUrl, apiKey, model, compatShape })` →
   mutates the live config in place.
5. `adapter.spawn(extraArgs)` → `child_process.spawn` with `stdio: "inherit"`;
   trap `SIGINT` / `SIGTERM` to run restore before exiting.
6. On child exit (any code): `adapter.restoreConfig(handle)`; keep backup file
   on disk. Propagate exit code.
7. If restore fails (e.g. disk full), print the backup path and the required
   `cp` command so the user can recover manually.

### 5.3 Hermes adapter specifics

- **detect:** `which hermes`; `hermes --version` for version. configPath =
  `~/.hermes/config.yaml`.
- **install:** prompt to run
  `curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash`.
  Never run unprompted.
- **snapshotConfig:** copy file verbatim; timestamp is RFC 3339 UTC.
- **writeOpperConfig:** parse YAML, replace the entire `model:` block with
  `{ provider, model, base_url, api_key }`; leave every other section
  untouched.
- **restoreConfig:** copy backup over live file.

### 5.4 `opper agents list`

Prints a table of known adapters, detection status, version, configPath. No
network calls.

### 5.5 Out of scope for v1

- Anything other than hermes. Phase 3 adds `pi`, `opencode`, `claude-code`.
- Profile-switching inside the agent (e.g. `hermes model --profile opper`).
  We rewrite the active config file and restore it; this pattern generalizes
  to other agents without assuming profile support.

## 6. Config & data structures

```jsonc
// ~/.opper/config.json — mode 0600
{
  "version": 1,
  "defaultKey": "default",
  "keys": {
    "default": {
      "apiKey": "op_live_...",
      "baseUrl": "https://api.opper.ai",
      "user": { "email": "...", "name": "..." },
      "obtainedAt": "2026-04-21T11:23:45Z",
      "source": "device-flow"
    }
  },
  "telemetry": { "enabled": true }
}
```

**Migration on first run:** if `~/.oppercli` (the Go CLI's YAML file) exists
and `~/.opper/config.json` does not, parse the YAML and translate. Print a
one-time migration notice. Leave `~/.oppercli` in place so the Go CLI keeps
working during the transition.

**Backups:** `~/.opper/backups/` with files named `<agent>-<iso>.<ext>`.
Rotate to keep the last 20 per agent.

**Environment overrides** (parity with Go CLI):

| Env var | Effect |
|---|---|
| `OPPER_API_KEY` | Overrides config lookup for the current invocation. |
| `OPPER_BASE_URL` | Overrides the base URL for the current invocation. |
| `OPPER_NO_TELEMETRY=1` | Disables telemetry. |

## 7. Command surface (MVP)

```
opper login           [--key <slot>]
opper logout          [--key <slot> | --all]
opper whoami          [--key <slot>]

opper launch <agent>  [--model <id>] [--install] [--key <slot>] [-- <agent args>]
opper agents list

opper setup           # interactive wizard; ports @opperai/setup

opper call <function> <instructions> [input]
                      [--model <id>] [--tags key=val,...] [--key <slot>]
opper models list     [filter] [--key <slot>]
opper models builtin  [filter] [--key <slot>]

opper version
opper --help | -h
```

Global flags: `--key <slot>`, `--debug`, `--no-telemetry`, `--no-color`.

Stdin handling for `call`: if `input` is omitted and stdin is piped, read it;
if stdin is a TTY and `input` is omitted, error with a hint.

## 8. Error handling

Single `OpperError` class with `code`, `message`, optional `hint`. Commands
throw; top-level formatter prints the error with kleur-colored severity and
exits with the code in the table below (0 for `USER_CANCELLED`, non-zero
otherwise).

| Code | Exit | When |
|---|---|---|
| `AUTH_REQUIRED` | 2 | No API key in the selected slot. |
| `AUTH_EXPIRED` | 2 | Upstream 401. Auto-trigger `login` on TTY; error otherwise. |
| `AGENT_NOT_FOUND` | 3 | Adapter's `detect()` returned `installed: false`. |
| `AGENT_CONFIG_CONFLICT` | 4 | Config file shape unexpected (e.g. no `model:` block). Print diff, abort, do not touch the file. |
| `AGENT_RESTORE_FAILED` | 5 | Restore after spawn failed. Print backup path and `cp` command. |
| `API_ERROR` | 6 | Upstream Opper error. Include request ID from response header. |
| `NETWORK_ERROR` | 7 | Fetch failed / DNS / timeout. |
| `USER_CANCELLED` | 0 | Ctrl-C during a prompt — not a failure. |

Agent launch always traps `SIGINT`/`SIGTERM` and runs restore before exit.
`SIGKILL` and crashes cannot be trapped; the backup file in
`~/.opper/backups/` is always the recovery path and is kept until rotation.

## 9. Rollout

**Phase 1 — Pivot MVP (0.1.x):**
`login`/`logout`/`whoami`, `launch hermes`, `agents list`, `setup`, `call`,
`models list`/`models builtin`, `version`.

**Phase 2 — Parity (0.2.x):**
Full `models` CRUD, `traces list/get` with `--live`, `usage list` with
CSV/graph, `indexes` full surface, `functions` full surface
(list/create/get/delete/chat, evaluations), `image generate`, `config`
subcommands (for users not using device flow).

**Phase 3 — Post-pivot:**
More agent adapters (`pi`, `opencode`, `claude-code` with Anthropic-compat),
shell completion, `opper upgrade` self-update, Homebrew bottle.

**Deprecation:** Go CLI (`opper-ai/oppercli`) receives security fixes only
once 0.2.x ships. README there redirects to `opper-ai/cli`.

## 10. Testing

- **Vitest** for unit + integration.
- **MSW** to mock Opper HTTP endpoints; no real network in tests.
- **Temp dirs** (`fs.mkdtempSync`) for agent adapter tests — real file I/O,
  never touching the user's `~`.
- **One E2E test per command** using the built binary against a mock server,
  run in CI via `execa`.
- Coverage target: 80 % lines. `src/agents/` module must hit **100 % branch
  coverage on snapshot/restore** — the filesystem is the user's and mistakes
  are painful.

## 11. Distribution & release

- **npm:** unscoped `opper` (confirmed available as of 2026-04-21).
- **Release:** GitHub Actions on tags `v*`, OIDC trusted publishing (matches
  `@opperai/login`). No `NPM_TOKEN` in the repo.
- **Bundle:** ship compiled `.js` (no bundler). Tree-shaking not required at
  this size.
- **Size budget:** < 500 KB published tarball.
- **Minimum Node:** 20.10, declared in `engines.node`.

## 12. Telemetry

Opt-out, on by default except in CI (`CI=true`). Fields:
`{ command, version, nodeVersion, os, exitCode, durationMs, anonId }`.
`anonId` is a random UUID v4 generated on first run and stored alongside
`telemetry.enabled` in the config.
Endpoint: `POST https://api.opper.ai/v3/telemetry/cli`.
Opt-outs: `--no-telemetry`, `OPPER_NO_TELEMETRY=1`, `telemetry.enabled=false`
in config.

**Open item to confirm with the platform team:** the exact telemetry endpoint
path on the v3 API.

## 13. Open items to confirm

- Exact Opper v3 OpenAI-compat base URL shape (e.g. `https://api.opper.ai/v3/openai`
  vs. `https://api.opper.ai/v3/chat/completions`).
- Provisioning the `opper_app_cli` public OAuth client ID on the device-flow
  server.
- Telemetry endpoint path on the v3 API.

These do not block design — they block launch. Flagged so the implementation
plan can sequence them.
