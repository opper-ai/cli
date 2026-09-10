# @opperai/cli

The official Opper CLI — authenticate, route AI agent inference through Opper, and manage the Opper platform from your terminal.

## Install

```bash
# Global (recommended)
npm i -g @opperai/cli
opper --help

# Or one-shot via npx
npx @opperai/cli login
```

The package installs an `opper` binary on PATH. Once installed, every command is just `opper <…>`.

> **Heads up:** if you previously installed the legacy Go CLI (`brew install opper-ai/oppercli/opper`), uninstall it first — both ship the `opper` binary and PATH order decides which one runs:
>
> ```bash
> brew uninstall opper
> ```
>
> The interactive menu also surfaces a warning when both are detected.

## Quickstart

```bash
opper login            # OAuth device flow
opper whoami           # confirm the active slot
opper agents list      # see which agents you can launch
opper launch claude    # route Claude Code through Opper
```

Run `opper` with no arguments for an interactive menu (Account · Ask · Agents · Skills · Opper). The menu also offers quick-launch shortcuts for any agent that's already installed and configured.

## Authentication

Auth state lives in `~/.opper/config.json` as a list of "slots", each holding an API key, a base URL, and the user metadata returned by the device flow. Use `--key <slot>` on any command to pick which slot to read from (defaults to `default`).

| Command | Description |
|---------|-------------|
| `opper login [--force] [--base-url <url>]` | OAuth device flow; stores into the active slot. |
| `opper logout [--all] [--yes]` | Clear credentials for the active slot, or every slot. |
| `opper whoami` | Show the authenticated user for the active slot. |
| `opper config add <name> <api-key> [--base-url <url>]` | Manually store an API key in a slot. |
| `opper config list` | List configured slots. |
| `opper config get <name>` | Print the raw API key (for scripting). |
| `opper config remove <name>` | Delete a stored slot. |

Key resolution at request time: `OPPER_API_KEY` env var > the slot named by `--key` (or `default`).

## Agents

`opper launch <agent>` starts a supported AI agent with its model traffic transparently routed through Opper. Pass-through args after the agent name go straight to the agent's CLI. Terminal agents run inside a fresh Opper **session** so every call the agent makes is grouped together for tracing and cost — see [Routing through a session without the CLI](#routing-through-a-session-without-the-cli) to wire that up by hand. After the session, the CLI prints a summary with duration, model, and a traces link. The usage summary uses the same key and API host as the launched session. If the usage request fails, it reports “Usage unavailable”; the rollup-delay hint is reserved for successful requests with no usage rows. Summary failures do not change the agent’s exit code. Desktop integrations use persistent gateway configuration.

```bash
opper agents list                # NAME / DISPLAY / KIND / STATE / CONFIG / COMMAND
opper launch claude              # Anthropic Messages shape → /v3/session/<id>/v1/messages
opper launch claude-desktop      # rewire Claude Desktop (GUI) → /v3/compat (persistent GUI profile)
opper --key prod launch codex-desktop --model claude-sonnet-5
opper launch opencode            # OpenAI Chat Completions shape → /v3/session/<id>/chat/completions
opper launch codex               # OpenAI Responses shape → /v3/session/<id>/responses
opper launch hermes              # OpenAI Chat Completions shape → /v3/session/<id>/chat/completions
opper launch openclaw            # OpenAI Chat Completions shape → /v3/session/<id>/chat/completions (background gateway)
opper launch pi                  # OpenAI Chat Completions shape → /v3/session/<id>/chat/completions

# Anything after the agent name is forwarded to its CLI — handy for
# scripting / cron with non-interactive flags.
opper launch pi -p "summarise this PR"
opper launch claude --resume
```

| Agent | Slug | How Opper plugs in |
|-------|------|--------------------|
| Claude Code | `claude` | `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` env vars |
| Claude Desktop | `claude-desktop` | writes a third-party-inference (`deploymentMode: "3p"`) profile into `~/Library/Application Support/Claude-3p/` (macOS) / `%LOCALAPPDATA%\Claude-3p\` (Windows); quits and reopens the GUI app to apply |
| OpenCode | `opencode` | provider block in `~/.config/opencode/opencode.json` |
| Codex CLI | `codex` | per-invocation Responses provider and model overrides; preserves shared configuration and supports current native profile files |
| Codex / ChatGPT desktop | `codex-desktop` | configures local Codex tasks on macOS with a persistent Responses provider, selected-key credential helper, and live Opper model catalog |
| Hermes | `hermes` | isolated `HERMES_HOME=~/.opper/hermes-home/` so your real `~/.hermes/` is never touched; `OPENAI_API_KEY` env var |
| OpenClaw | `openclaw` | `opper` provider entry in `~/.openclaw/agents/main/agent/models.json`; `opper launch openclaw` defaults to `gateway start` (background daemon) |
| Pi | `pi` | `opper` provider entry in `~/.pi/agent/models.json` (added/removed idempotently next to your other providers) |

`opper launch <agent> --install` runs the upstream agent's installer if it's missing (where supported). Claude Desktop is GUI-only on macOS/Windows and has no scripted installer — install it from <https://claude.ai/download> first.

The CLI also offers a per-agent submenu (`opper` → Agents → *agent* → Launch with model…) that lets you pick a specific Opper model from the catalog instead of the default. Claude Desktop's picker is restricted to Claude-backed routes because its third-party gateway rejects non-Anthropic models; the generated profile defaults to Claude Opus 5 and also includes Sonnet 5, Haiku 4.5, and Fable 5.1.

For OpenCode, each launch fetches `/v3/compat/models` using the same key and API host as the launched session, including when you select a different slot with `--key`. The generated model map and whitelist limit Opper's picker entries to the returned models supported by the CLI. These settings also apply at runtime so an older project configuration cannot restore removed entries or override the launch URL. Unrelated inline `OPENCODE_CONFIG_CONTENT` settings are preserved. Inherited inline authorization headers are removed. Before updating the Opper provider, launch checks OpenCode's merged settings and stops if provider or allowed-model authorization headers could override the selected key. Existing JSONC configuration files are edited narrowly so unrelated settings and comments survive setup and launch; malformed files are left unchanged with an error.

If the allowed list is empty, OpenCode has no Opper models to select. If the authenticated catalog request fails, launch stops before changing configuration; it does not substitute the bundled catalog. `opper editors opencode` also writes a whitelist when it fetches models; use `--overwrite` to refresh an existing Opper provider block.

For Claude Code, use version **2.1.257 or later**. `opper launch claude` starts on Opus 5 and enables gateway model discovery, adding the Claude models available to your Opper key to Claude Code's `/model` picker. Claude Code keeps its built-in choices and filters discovered IDs to those containing `claude` or `anthropic`; Opper enforces model access on each request. Discovery refreshes at startup, so restart after changing your Opper model rules. If discovery fails, Claude Code can fall back to its cached or built-in list. Nonessential traffic stays disabled, which also disables Claude Code's automatic updates during these launches; update Claude Code separately before a demo.

```bash
opper launch claude --model claude-sonnet-5
opper launch claude --model claude-fable-5-1
# Request the full context window supported by these models:
opper launch claude --model 'claude-opus-5[1m]'
```

The Opper routing and credential apply only to the launched process. Claude Code can still save model selections and its discovery cache; use the picker's session-only selection to keep your existing default. See [Claude Code's gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery) for discovery and client-version behavior.

To remove an agent's Opper integration without uninstalling the agent itself:

```bash
opper agents remove claude-desktop   # works for any registered adapter
```

This is the non-interactive equivalent of the menu's "Remove Opper integration" action. It clears Opper-owned config (e.g., flips Claude Desktop's `deploymentMode` back to `"1p"`, removes the `opper` provider block from OpenCode / Pi / OpenClaw, etc.) without touching anything you put there yourself.

### Codex / ChatGPT desktop on macOS

Install the app with local Codex support from [ChatGPT downloads](https://chatgpt.com/download). The bundled Codex runtime must be version 0.153.4 or later. The separate ChatGPT Classic app is not supported.

```bash
# Configure and open the app with the selected stored key and model
opper --key prod launch codex-desktop --model claude-sonnet-5

# Configure without launching (also available in the Agents menu)
opper --key prod agents configure codex-desktop --model claude-sonnet-5

# Restore the previous provider, model and catalog
opper agents remove codex-desktop
```

If the app is already running, the CLI saves the configuration and reports that a restart is required. Quit and reopen the app, then create a new **local Codex task**. Existing tasks keep their provider. This integration covers local Codex tasks; ordinary ChatGPT conversations and cloud tasks are separate.

Setup refreshes the model picker from the selected key's authorized, tool-capable Opper catalog, using the same API root as inference. Run the launch or configure command again to refresh the catalog or change keys/models. Models without confirmed tool support are excluded.

Codex's built-in web search is disabled while this integration is enabled: its default cached-only search relies on an OpenAI service that Opper cannot reproduce across model providers. The previous search setting is restored when removing the integration. File tools and sub-agents remain enabled.

With the default `~/.codex` home, the app reads the selected slot through a local credential helper, so it also works when opened from Finder. The API key stays in the Opper credential store. Rotating that slot's key is picked up when Codex refreshes credentials; deleting the slot stops future credential retrieval. If the slot's API host changes, rerun setup before using it.

Configuration is stored in `~/.codex/config.toml` (or `CODEX_HOME`) and helper/catalog/backup files in `CODEX_HOME/opper-desktop/`. Because Codex CLI and the desktop app share this configuration, plain `codex` also sees these defaults. `opper launch codex` supplies its own provider/model and disables built-in web search per invocation, without changing saved settings. Explicit native `--model` or `--profile` choices take precedence over the launcher's default model; current profiles are separate `NAME.config.toml` files.

Use `--codex-home <path>` on desktop configure, launch, and removal to select a separate Codex home. The option takes precedence over `CODEX_HOME`, which remains supported; otherwise the default is `~/.codex`. Setup changes only the selected directory. Ordinary Finder launches still use `~/.codex`; they do not inherit the shell environment. Configure prints a launch command preserving your custom home, key, model, and API root. Use that command for subsequent launches (and after quitting an already-running app). Opper does not change global macOS launch settings.

```sh
opper --key prod agents configure codex-desktop --codex-home "$HOME/.codex-opper-test"
opper --key prod launch codex-desktop --codex-home "$HOME/.codex-opper-test"
opper agents remove codex-desktop --codex-home "$HOME/.codex-opper-test"
```

A separate Codex home isolates Codex settings and task data. It does not by itself start a second desktop app instance or isolate the app's Electron profile.

Removal restores previous defaults and preserves unrelated settings, comments, and deliberate model changes made afterward. If the generated provider was edited independently, removal reports a conflict and retains the backup. Symlinked config files are refused before writing; use `--codex-home <path>` to keep a dotfile-managed configuration intact. Restart the app after removal.

## Routing through a session without the CLI

For terminal agents, `opper launch` mints a session id and points the agent's inference base URL at a **session-scoped** Opper endpoint, then lets the agent's own SDK speak its native protocol on top. You can wire this up by hand with any OpenAI-, Responses-, or Anthropic-shaped client — no CLI required. Desktop integrations use persistent `/v3/compat` configuration and do not get a per-launch session.

### The endpoint

```
https://api.opper.ai/v3/session/<session-id>[/<tag>:<value>…]/<native-path>
```

- **`<session-id>`** — a stable id of the form `sess_<uuid>` (e.g. `sess_3c0a79fd-e8e1-49c5-bc19-62ddd85f00c7`). Reuse the same id for every call in one logical run to group them into a single session. The server validates the format — an id that doesn't start with `sess_` is rejected with `400 {"error":"invalid session id"}`.
- **`<tag>:<value>`** — optional attribution tags, added as extra path segments (e.g. `/team:growth/env:prod`). URL-encode values; keep keys to `[A-Za-z][A-Za-z0-9_.-]*` and avoid the reserved `opper.` prefix.
- **`<native-path>`** — whatever path your client's SDK already appends. It also selects the compatibility shape:

| Client speaks | SDK appends | Full session URL |
|---|---|---|
| OpenAI Chat Completions | `/chat/completions` | `…/v3/session/<id>/chat/completions` |
| OpenAI Responses | `/responses` | `…/v3/session/<id>/responses` |
| Anthropic Messages | `/v1/messages` | `…/v3/session/<id>/v1/messages` |

It's the same behaviour as the `/v3/compat/...` endpoints, just scoped to a session: the `/v3/session/<id>` prefix takes the place of `/v3/compat`, and the native tail still picks the wire shape.

### Auth

Standard Opper bearer token, identical on every shape:

```
Authorization: Bearer $OPPER_API_KEY
```

(Anthropic SDKs default to `x-api-key` — set `Authorization` explicitly, or use `ANTHROPIC_AUTH_TOKEN`.)

### Example — a raw call, no CLI

```bash
SID="sess_$(uuidgen | tr '[:upper:]' '[:lower:]')"

curl -s "https://api.opper.ai/v3/session/$SID/chat/completions" \
  -H "Authorization: Bearer $OPPER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

The response is an ordinary chat completion, with `cost`, `usage`, and a `meta.trace_uuid` for the call. Every request you send to the same `$SID` — any model, any wire shape — lands in that one session.

### Point a client at it

Set the client's base URL to the session endpoint (without the native path — the SDK adds that) and use your Opper key. How you set it depends on the client:

**Env-var clients** — any OpenAI-compatible SDK, and env-var-driven agents like Claude Code, read the base URL from the environment:

```bash
SID="sess_$(uuidgen | tr '[:upper:]' '[:lower:]')"

# OpenAI-compatible SDKs / clients
export OPENAI_BASE_URL="https://api.opper.ai/v3/session/$SID"
export OPENAI_API_KEY="$OPPER_API_KEY"

# Claude Code (Anthropic-shaped)
export ANTHROPIC_BASE_URL="https://api.opper.ai/v3/session/$SID"
export ANTHROPIC_AUTH_TOKEN="$OPPER_API_KEY"
```

**Config-file agents** — OpenCode, Hermes, Pi, and OpenClaw don't read those env vars; they take the base URL from their own provider config (`opencode.json`, Hermes' `base_url`, `~/.pi/agent/models.json`, …). Point that provider's base URL at `https://api.opper.ai/v3/session/<id>` and use your Opper key.

Either way, that is exactly what `opper launch` does for you — plus a fresh id per run and an end-of-session cost summary.

## Ask — built-in support agent

`opper ask "<question>"` runs an Opper agent grounded on the locally-installed Opper skills (see below). Useful for "how do I…" questions about the platform, SDKs, or the CLI itself.

```bash
opper ask "how do I create an index?"
opper ask --model claude-opus-5 "compare the v2 and v3 APIs"
```

The answer streams in, then prints a token / request count. Requires Opper skills to be installed first (`opper skills install`).

## Skills

Opper skills are markdown documentation packs the CLI uses for grounding `opper ask` and that you can install for any compatible code agent. The CLI delegates to the upstream `skills` tool, which fetches from [opper-ai/opper-skills](https://github.com/opper-ai/opper-skills) and symlinks into your agents' skill paths (`~/.claude/skills/`, etc.).

```bash
opper skills install     # `npx skills add opper-ai/opper-skills` — interactive picker
opper skills update      # refetch the latest from the source repo
opper skills list        # per-target install matrix
opper skills uninstall   # remove + clean up legacy bundled-copy installs
```

## Editor integrations

```bash
opper editors list
opper editors opencode [--global|--local] [--overwrite]   # also exposed as `opper launch opencode`
```

## Platform

Direct access to the platform endpoints:

| Command | Description |
|---------|-------------|
| `opper call <name> <instructions> [input] [--model <id>] [--stream]` | Run an Opper function. Reads input from stdin when the positional arg is omitted. |
| `opper functions list [filter]` / `get <name>` / `delete <name>` | Manage functions. |
| `opper models list [filter]` | List available models (built-in + custom). |
| `opper models create <name> <identifier> <apiKey> [--extra <json>]` | Register a custom model. |
| `opper models get <name>` / `delete <name>` | Inspect / remove a custom model. |
| `opper indexes list [--limit] [--offset]` | List knowledge-base indexes. |
| `opper indexes get <name>` / `create <name> [--embedding-model <id>]` / `delete <name>` | Manage indexes. |
| `opper indexes add <name> <content> [--key <id>] [--metadata <json>]` | Add a document (`<content>` accepts `-` for stdin). |
| `opper indexes query <name> <query> [--top-k <n>] [--filters <json>]` | Semantic search. |
| `opper traces list [--limit] [--offset] [--name <substring>]` | List traces. |
| `opper traces get <id>` / `delete <id>` | Inspect / remove a trace. |
| `opper usage list [--from-date] [--to-date] [--granularity] [--fields] [--group-by] [--out csv]` | Token / cost analytics. |
| `opper image generate <prompt> [-o <file>] [--base64] [-m <model>]` | Generate an image. |

## Recipes

### Calling a function from the shell or stdin

```bash
# Inline arguments
opper call myfunction "respond in kind" "what is 2+2?"

# Stream the response token-by-token
opper call --stream myfunction "respond in kind" "what is 2+2?"

# Pipe input from stdin (any text)
echo "what is 2+2?" | opper call myfunction "respond in kind"

# Pipe structured JSON in
echo '{"name":"Johnny","age":41}' | opper call myfunction "only print age"

# Override the model for one call
opper call --model claude-sonnet-5 myfunction "summarise" "long text…"
```

### Registering a custom model

Bring your own model deployment under any provider Opper supports — Azure, AWS, GCP, custom OpenAI-compatible endpoints, etc. Pass any provider-specific config through `--extra` as a JSON object.

```bash
# Azure OpenAI deployment
opper models create my-gpt4 azure/my-gpt4-deployment my-api-key \
  --extra '{"api_base": "https://my-gpt4-endpoint.openai.azure.com/", "api_version": "2024-06-01"}'

# Inspect / delete
opper models get my-gpt4
opper models delete my-gpt4
```

### Indexing and querying a knowledge base

```bash
# Create an index
opper indexes create support-docs

# Add documents (inline or from stdin)
opper indexes add support-docs "How to reset your password: …" --key reset-password
cat refunds.md | opper indexes add support-docs - --key refunds --metadata '{"category":"billing"}'

# Search
opper indexes query support-docs "how do I get a refund?" --top-k 5
opper indexes query support-docs "billing question" --filters '{"category":"billing"}'
```

### Cost / usage by tag

If your application tags calls with arbitrary metadata (e.g. `customer_id`), `opper usage list` can group cost / count / tokens by that tag. Tagging happens at call time via the SDK:

```python
# Python SDK
result, _ = await opper.call(
    name="respond",
    input="What is the capital of Sweden?",
    tags={"customer_id": "acme"},
)
```

```bash
# Then attribute spend per tag
opper usage list --from-date=2026-04-01 --to-date=2026-04-30 \
  --fields=total_tokens,cost --group-by=customer_id

# Pipe to CSV for billing systems
opper usage list --from-date=2026-04-01 --group-by=customer_id --out=csv > april.csv
```

### Generating an image

Runs against `POST /v3/images`, so any model from `opper models list image`
works — including dedicated image models like `openai/gpt-image-2`. The
default is `gemini/gemini-3.1-flash-lite-image` (fast, ~$0.03/image).

```bash
# Save to image_<ts>.<ext> in cwd — the extension follows the bytes the
# model returned (gemini emits JPEG, gpt-image emits PNG)
opper image generate "a serene mountain lake at dawn"

# Specific output, specific model
opper image generate "logo concept" -o ./out/logo.png \
  -m openai/gpt-image-2

# Print raw base64 (for piping)
opper image generate "icon" --base64 | base64 -d > icon.png
```

Generated images are not persisted to `/v3/files` — you get the bytes and
nothing counts against the org's storage quota.

### Routing an agent through Opper for a one-shot job

```bash
# Pi in non-interactive mode for cron / CI
opper launch pi -p "summarise the latest PR title and body"

# Claude Code with a specific model and resumed session
opper launch claude --model claude-opus-5 --resume

# Codex with Sonnet for a single ask
opper launch codex --model claude-sonnet-5 -- "implement this feature"
```

## Global flags

| Flag | Description |
|------|-------------|
| `--key <slot>` | API key slot to use (default: `default`). |
| `--debug` | Verbose diagnostic output. |
| `--no-telemetry` | Disable anonymous telemetry. |
| `--no-color` | Disable ANSI colors. |
| `-v, --version` | Print CLI version. |
| `-h, --help` | Show help (grouped by domain). |

## Requirements

- Node.js ≥20.12 (for `util.styleText`, used by interactive prompts).
- macOS, Linux, or WSL. Native Windows shells aren't tested.

## Releasing

Releases are driven by a tag. Nothing publishes on a merge to `main`.

```bash
# 1. bump the version on a branch, and open a PR
npm version patch --no-git-tag-version   # or minor / major

# 2. merge it

# 3. tag the merge commit
git checkout main && git pull
git tag v0.1.30 && git push origin v0.1.30
```

Pushing the tag runs `.github/workflows/release.yml`, which builds, tests,
publishes to npm and cuts the GitHub release.

The tag and `package.json` must name the same version; the workflow checks this
before building and fails if they disagree. Both the npm publish and the GitHub
release are idempotent, so re-running a half-finished release completes it
rather than erroring.

Two things not to change without care: the workflow's **filename**, which npm's
trusted-publishing config pins alongside the org and repo, and the fact that it
never pushes to `main` — the `require-pr-main` ruleset has no bypass list, and a
workflow that pushes a commit there is rejected before it reaches npm.

## Source

[github.com/opper-ai/cli](https://github.com/opper-ai/cli)
