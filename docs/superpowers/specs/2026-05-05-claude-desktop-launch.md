# Claude Desktop launch support

**Date:** 2026-05-05
**Status:** Approved (brainstorm), pending plan

## Goal

Add `opper launch claude-desktop` so users can route Claude Desktop's inference through the Opper gateway, mirroring what `ollama launch claude-desktop` does for the Ollama Cloud gateway. Reuse the existing `AgentAdapter` framework — no contract changes.

Add `opper agents uninstall <name>` as a non-interactive uninstall surface, since today only the interactive menu can call `adapter.unconfigure()`. Folded into this spec because the matching CLI surface for `opper launch <name>` is otherwise missing.

## Background

Claude Desktop ships with a built-in "third-party inference" mode (`deploymentMode: "3p"`). Ollama exploits this — they don't reverse-engineer the app, they write to its documented profile system. We can do the same. Opper's compat endpoint already speaks Anthropic Messages format at `/v1/messages` and `/v1/models`, which is exactly what Claude Desktop calls when in 3p mode.

Reference: [`ollama/cmd/launch/claude_desktop.go`](https://github.com/ollama/ollama/blob/main/cmd/launch/claude_desktop.go).

## Configuration mechanism

Claude Desktop reads two profile trees:

| Platform | Normal config root | Third-party config root |
|---|---|---|
| macOS | `~/Library/Application Support/Claude/` | `~/Library/Application Support/Claude-3p/` |
| Windows | `%LOCALAPPDATA%\Claude\` (also `Claude Nest\`) | `%LOCALAPPDATA%\Claude-3p\` (also `Claude Nest-3p\`) |

Three files are written on `configure`:

1. **`<normal>/claude_desktop_config.json`** — set `"deploymentMode": "3p"`. Preserves all other keys.
2. **`<3p>/claude_desktop_config.json`** — same, set `"deploymentMode": "3p"`.
3. **`<3p>/configLibrary/_meta.json`** — register the Opper profile entry:
   ```json
   {
     "appliedId": "<OPPER_PROFILE_ID>",
     "entries": [
       { "id": "<OPPER_PROFILE_ID>", "name": "Opper" }
     ]
   }
   ```
   If the file already has other entries, they are preserved; the Opper entry is upserted.
4. **`<3p>/configLibrary/<OPPER_PROFILE_ID>.json`** — the gateway profile:
   ```json
   {
     "inferenceProvider": "gateway",
     "inferenceGatewayBaseUrl": "https://api.opper.ai/v3/compat",
     "inferenceGatewayApiKey": "<slot api key>",
     "inferenceGatewayAuthScheme": "bearer",
     "disableDeploymentModeChooser": true
   }
   ```

`OPPER_PROFILE_ID` is a hardcoded UUID v4 (constant), so re-running `configure` updates the same profile rather than spawning duplicates. Value: `727f05c8-a429-43cc-b1c6-36d8883d98b8`.

`unconfigure` reverses all three files:
- Set `deploymentMode` back to `"1p"` in both config files.
- Remove the Opper entry from `_meta.json` `entries`; clear `appliedId` if it equals `OPPER_PROFILE_ID`.
- In the profile JSON, delete `inferenceProvider`, `inferenceGatewayBaseUrl`, `inferenceGatewayApiKey`, `inferenceGatewayAuthScheme`, and set `disableDeploymentModeChooser: false`. (The file is left in place so re-running `configure` is fast; the gateway fields are what matter.)

## Architecture

### New: `src/agents/claude-desktop.ts`

Implements `AgentAdapter`:

- `name: "claude-desktop"`, `displayName: "Claude Desktop"`, `docsUrl: "https://claude.ai/download"`.
- **`detect()`**
  - macOS: stat `/Applications/Claude.app` and `~/Applications/Claude.app`.
  - Windows: stat the candidates ollama enumerates — `%LOCALAPPDATA%\Programs\Claude\Claude.exe`, `%LOCALAPPDATA%\Programs\Claude Desktop\Claude.exe`, `%LOCALAPPDATA%\Claude\Claude.exe`, `%LOCALAPPDATA%\Claude Nest\Claude.exe`, `%LOCALAPPDATA%\Claude Desktop\Claude.exe`, `%LOCALAPPDATA%\AnthropicClaude\Claude.exe`, plus globs `%LOCALAPPDATA%\AnthropicClaude\app-*\Claude.exe`, `%LOCALAPPDATA%\Programs\Claude\app-*\Claude.exe`, `%LOCALAPPDATA%\Programs\Claude Desktop\app-*\Claude.exe`.
  - Linux: returns `{ installed: false }`.
  - Returns `{ installed: true, configPath: <profile-uuid path> }` on hit.
- **`isConfigured()`** — `true` iff `deploymentMode == "3p"` in both normal and 3p `claude_desktop_config.json`, AND the profile JSON has `inferenceProvider == "gateway"` AND `inferenceGatewayBaseUrl` matches `OPPER_COMPAT_URL` AND `inferenceGatewayApiKey` is non-empty AND `_meta.json`'s `appliedId == OPPER_PROFILE_ID`.
- **`configure({ apiKey })`** — writes the three files described above. Throws `AUTH_REQUIRED` if `apiKey` is missing (matches `openclaw.configure`).
- **`unconfigure()`** — reverses. No-op when files are missing or already in 1p.
- **`install()`** — throws `OpperError("AGENT_NOT_FOUND", ...)` with a "download from claude.ai/download" hint. Same shape as `claudeCode.install`.
- **`spawn(args, routing)`**
  - If `args.length > 0` → throw `OpperError` "claude-desktop does not accept passthrough arguments".
  - Run `configure({ apiKey: routing.apiKey })`.
  - Detect if the app is currently running, using existing `src/util/run.ts` (which wraps `spawnSync`, no shell):
    - macOS: `pgrep -f Claude.app/Contents/MacOS/Claude`
    - Windows: invoke `powershell.exe` with `-NoProfile -Command` and a fixed inline script (no user input is interpolated). Script: `(Get-Process claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).Id`.
  - If running:
    - macOS: invoke `osascript` with `-e 'tell application "Claude" to quit'`.
    - Windows: invoke `powershell.exe` with `-NoProfile -Command` and a fixed inline script: `Get-Process claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [void]$_.CloseMainWindow() }`.
    - Poll every 200ms up to **5 seconds** for the process to disappear (ollama uses 30s; we use 5s because the existing session-summary printer kicks in at >1.5s and we'd rather error out than print a misleading summary).
    - If still running after 5s: throw `OpperError` "Claude Desktop did not quit within 5s; quit it manually and re-run."
  - Open the app:
    - macOS: invoke `open` with args `["-a", "Claude"]`.
    - Windows: invoke `powershell.exe` with `-NoProfile -Command "Start-Process -FilePath '<discovered .exe path>'"` — the path is built from `%LOCALAPPDATA%` candidates we discovered in `detect`, not from user input, and is single-quote-escaped per the same helper ollama uses.
  - Return `0`.

All shell-outs go through `execFile`-shaped APIs (the existing `src/util/run.ts` `spawnSync` wrapper, which already takes `(command, args)` and never invokes `/bin/sh -c`). No string concatenation of arguments.

### Modified: `src/agents/registry.ts`

Append `claudeDesktop` to the `ADAPTERS` array, after `claudeCode`.

### New: `opper agents uninstall <name>`

A small, non-interactive companion to `opper launch <name>`:

- **`src/commands/agents.ts`** — add `agentsUninstallCommand(name: string)`:
  - Resolve `getAdapter(name)`; throw `OpperError("AGENT_NOT_FOUND")` if unknown.
  - Call `adapter.unconfigure()`.
  - Print `${displayName} integration removed.` (matches the menu's success message at `src/commands/menu/agents.ts:122`).
- **`src/cli/agents.ts`** — register the subcommand:
  ```ts
  agentsCmd
    .command("uninstall <name>")
    .description("Remove the Opper integration from an agent's config (does not uninstall the agent itself)")
    .action(async (name: string) => { await agentsUninstallCommand(name); });
  ```

This works for every adapter in the registry, not just `claude-desktop`, and parallels the existing menu uninstall.

## Data flow

```
opper launch claude-desktop
  └── launchCommand()
       ├── adapter.detect()           — is Claude.app present?
       └── adapter.spawn([], routing)
            ├── configure({ apiKey })
            │    ├── write Claude/claude_desktop_config.json     (deploymentMode: 3p)
            │    ├── write Claude-3p/claude_desktop_config.json  (deploymentMode: 3p)
            │    ├── write Claude-3p/configLibrary/_meta.json    (entry + appliedId)
            │    └── write Claude-3p/configLibrary/<uuid>.json   (gateway settings)
            ├── if running: osascript quit + 5s poll
            └── open -a Claude

opper agents uninstall claude-desktop
  └── agentsUninstallCommand("claude-desktop")
       └── adapter.unconfigure()
            ├── flip deploymentMode back to 1p in both config files
            ├── remove Opper entry / appliedId from _meta.json
            └── delete gateway fields from <uuid>.json
```

## Error handling

| Scenario | Behaviour |
|---|---|
| Claude Desktop not installed, no `--install` | `AGENT_NOT_FOUND` with `docsUrl` hint (existing `launchCommand` path) |
| `--install` flag passed | `install()` throws `AGENT_NOT_FOUND` "Claude Desktop must be installed manually from claude.ai/download" |
| Linux | `detect` returns `{ installed: false }`; surfaces as the standard not-installed error |
| Passthrough args (`opper launch claude-desktop -- foo`) | `OpperError` "claude-desktop does not accept passthrough arguments" |
| Quit times out after 5s | `OpperError` "Claude Desktop did not quit within 5s; quit it manually and re-run." |
| TCC denial (user declines "opper would like to control Claude") | `osascript` returns non-zero; wrap with hint: "macOS denied automation permission. Grant access in System Settings → Privacy & Security → Automation, then re-run." |
| Config write fails | Bubble the `fs` error with the path that was being written |
| Slot has no API key | Existing `launchCommand` path triggers `loginCommand`, same as for every other adapter |
| `opper agents uninstall <unknown>` | `AGENT_NOT_FOUND` with the same hint as `launchCommand` |

## File atomicity

Skip ollama's `WriteWithBackup` mechanism — node's `fs.promises.writeFile` is atomic-on-same-fs replacement on macOS and Windows. Same approach as the openclaw adapter, which writes its own `models.json` with a plain `writeFile`. The config is fully reconstructable from `unconfigure` + `configure` if it ever ends up corrupt.

## Testing

Following the patterns in `test/agents/claude-code.test.ts` and `test/agents/opencode.test.ts`:

- **`test/agents/claude-desktop.test.ts`** (new):
  - `detect` returns `installed: false` when no app candidate stats successfully (mocked `fs.existsSync` + `os.platform`).
  - `detect` returns `installed: true` when `/Applications/Claude.app` stats successfully on darwin.
  - `detect` returns `installed: false` on linux regardless of fs state.
  - `configure` writes all three JSON files with the expected shape and merges into existing keys (test against pre-populated config files in a tmp dir).
  - `configure` throws `AUTH_REQUIRED` when called without an `apiKey`.
  - `configure` is idempotent — calling it twice produces the same final state and doesn't duplicate `_meta.json` entries.
  - `isConfigured` returns `true` after `configure`, `false` after `unconfigure`, `false` on a fresh tree.
  - `unconfigure` after `configure` flips `deploymentMode` to `"1p"`, removes the Opper entry, blanks the gateway fields, and **leaves user-owned siblings intact** (third-party `_meta.json` entries from other tools are preserved).
  - `unconfigure` on an unconfigured tree is a no-op (no errors, no writes).
  - `spawn` with `args.length > 0` throws.
  - `spawn` calls `configure`, detects "not running", opens the app once. (Mock `child_process.spawnSync` and the `run` helper.)
  - `spawn` calls `configure`, detects "running", sends quit, polls until exit, opens the app.
  - `spawn` errors when the app fails to quit within 5s.
  - `install` throws `AGENT_NOT_FOUND` with the manual-install hint.

- **`test/agents/registry.test.ts`** (modified): assert `claude-desktop` is registered and `isLaunchable(getAdapter("claude-desktop")) === true`.

- **`test/commands/agents.test.ts`** (modified, already exists for `agentsListCommand`): add assertions that `agentsUninstallCommand` resolves the adapter and calls `unconfigure`, and that an unknown name throws `AGENT_NOT_FOUND`.

## Constants & filesystem helpers

A small block of constants at the top of `claude-desktop.ts`:

```ts
const OPPER_PROFILE_ID = "727f05c8-a429-43cc-b1c6-36d8883d98b8";
const OPPER_PROFILE_NAME = "Opper";
const QUIT_TIMEOUT_MS = 5_000;
const QUIT_POLL_INTERVAL_MS = 200;
```

Path resolution lives in module-private helpers (`darwinProfileRoots`, `windowsProfileRoots`, `targetPaths`) — same shape as ollama, ported to TS. No new shared util — the helpers stay local to the adapter because they're not reused.

## Out of scope

- `--config` / `--restore` / `--yes` flags. We use the existing menu and the new `opper agents uninstall` command instead.
- Pre-flight API key validation against `/v1/models`. Trust the slot like every other `opper launch` adapter.
- Linux support. Anthropic doesn't ship a Linux build of Claude Desktop.
- Backup files (`.bak`). Reconstructable via `unconfigure` + `configure`.
- Session-summary threshold tuning. The brief "0 cost / 0 tokens" summary that may print on a quit-and-reopen run is acceptable — the command clearly returns directly, so users won't read it as a real session.
