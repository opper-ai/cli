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

Runtime auth state lives in `~/.opper/config.json` as a list of "slots", each holding an API key, a base URL, and the user metadata returned by the device flow. Use `--key <slot>` on runtime commands to pick which slot to read from (defaults to `default`). Private key creation below uses its own browser authorization instead.

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

`opper launch <agent>` starts a supported AI agent with its model traffic transparently routed through Opper. Pass-through args after the agent name go straight to the agent's CLI. Each launch — except Claude Desktop (see the table below) — runs inside a fresh Opper **session** so every call the agent makes is grouped together for tracing and cost — see [Routing through a session without the CLI](#routing-through-a-session-without-the-cli) to wire that up by hand. After the session, the CLI prints a summary with duration, model, and a traces link.

```bash
opper agents list                # NAME / DISPLAY / KIND / STATE / CONFIG / COMMAND
opper launch claude              # Anthropic Messages shape → /v3/session/<id>/v1/messages
opper launch claude-desktop      # rewire Claude Desktop (GUI) → /v3/compat (persistent GUI profile)
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
| Codex | `codex` | sentinel-managed `[model_providers.opper]` + `[profiles.opper-opus]` block in `~/.codex/config.toml` |
| Hermes | `hermes` | isolated `HERMES_HOME=~/.opper/hermes-home/` so your real `~/.hermes/` is never touched; `OPENAI_API_KEY` env var |
| OpenClaw | `openclaw` | `opper` provider entry in `~/.openclaw/agents/main/agent/models.json`; `opper launch openclaw` defaults to `gateway start` (background daemon) |
| Pi | `pi` | `opper` provider entry in `~/.pi/agent/models.json` (added/removed idempotently next to your other providers) |

`opper launch <agent> --install` runs the upstream agent's installer if it's missing (where supported). Claude Desktop is GUI-only on macOS/Windows and has no scripted installer — install it from <https://claude.ai/download> first.

The CLI also offers a per-agent submenu (`opper` → Agents → *agent* → Launch with model…) that lets you pick a specific Opper model from the catalog instead of the default. Claude Desktop's picker is restricted to Claude-backed routes because its third-party gateway rejects non-Anthropic models; the generated profile defaults to Claude Opus 5 and also includes Sonnet 5, Haiku 4.5, and Fable 5.1.

To remove an agent's Opper integration without uninstalling the agent itself:

```bash
opper agents remove claude-desktop   # works for any registered adapter
```

This is the non-interactive equivalent of the menu's "Remove Opper integration" action. It clears Opper-owned config (e.g., flips Claude Desktop's `deploymentMode` back to `"1p"`, removes the `opper` provider block from OpenCode / Pi / OpenClaw, etc.) without touching anything you put there yourself.

## Routing through a session without the CLI

For every launchable agent except Claude Desktop, `opper launch` is a thin convenience wrapper. Under the hood it does one thing: it mints a session id and points the agent's inference base URL at a **session-scoped** Opper endpoint, then lets the agent's own SDK speak its native protocol on top. You can wire this up by hand with any OpenAI-, Responses-, or Anthropic-shaped client — no CLI required. (Claude Desktop is the exception — it rewires a persistent `/v3/compat` GUI profile instead, so it doesn't get a per-launch session.)

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
opper editors opencode [--global|--local] [--overwrite]   # configure inference without launching
```

OpenCode is a coding agent; its inference setup remains under `editors` for
compatibility. Use `opper launch opencode` to run it with inference through Opper.

## MCP client setup

```bash
opper mcp add opencode                            # account MCP only, no inference changes
opper mcp add opencode --local --url http://localhost:8080/mcp
```

`opper mcp add` currently supports **OpenCode only**. This configures the agent's
access to Opper account tools; `opper launch <agent>` separately runs an agent
with model inference through Opper. Setup helpers for other MCP clients are not
implemented yet.

The command adds the remote `https://api.opper.ai/mcp` server as `opper`. It leaves
your inference provider, model, tool permissions, and other MCP servers alone.
It needs no API key and does not log in, launch OpenCode, or approve consent.
The default connection contains only the server URL and connection settings:

```json
{
  "mcp": {
    "opper": {
      "type": "remote",
      "url": "https://api.opper.ai/mcp",
      "enabled": true
    }
  }
}
```

Reopen OpenCode, connect the server, and choose your organization and permissions
in Opper in your browser. Available permissions are discovered from Opper; only
the permissions you approve are granted. If the
client requires manual authentication, use `opencode mcp auth opper`, then
reopen OpenCode to load the authenticated tools.
Availability of the endpoint depends on the Opper MCP deployment.

OpenCode 1.18.29 cannot automatically complete a permission upgrade after a tool
reports insufficient scope. Start its native authentication flow again and
approve the additional permissions in Opper. With the default URL-only setup,
this does not require editing the MCP config. An agent can guide the workflow;
the account owner approves access in the browser.

For an advanced client-side restriction, use `--scopes` to limit the
permissions that can be offered during consent:

```bash
# Restrict this client to account and project inspection.
opper mcp add opencode --scopes 'account:read projects:read'
```

`--scopes` replaces only the matched server's requested scope setting. It
never adds unselected permissions, grants access, or changes existing tokens.
Reopen OpenCode after changing this restriction and use its native authentication
flow to review and approve permissions in the browser. Consent cannot exceed
the explicit restriction. To return an existing connection to normal discovery,
remove its `oauth.scope` property from the effective OpenCode config, preserving
any other OAuth settings, then reopen OpenCode and authenticate again. Plain
`opper mcp add opencode` preserves existing restrictions, including those from
earlier CLI versions.
To revoke an existing grant, disconnect it in the Opper app. Config changes alone
do not revoke grants.

The setup preserves JSONC comments and reads both `opencode.json` and
`opencode.jsonc` (plus global `config.json`) in OpenCode's merge order. New MCP
settings go into the existing JSONC file when present, otherwise the JSON file.
An existing server with the same URL keeps its current name, auth settings,
and enabled/disabled preference; an explicit `--scopes` updates only its
OAuth scope. If OAuth is disabled, an explicit `--scopes` change asks you to
review that setting instead of enabling it; plain setup preserves it and
explains how to enable browser consent. Remove the matched server's
`oauth: false` setting from the effective config, then reopen OpenCode.
A conflicting `opper` entry, malformed config,
or duplicate JSON keys produces an error without changing the files. `--url` accepts
HTTPS endpoints or HTTP loopback addresses, without credentials, query parameters,
or fragments.

When setup updates an existing regular config, it retains the original file in
a private `.opper-mcp-*` backup directory beside it and prints that backup path.
It captures and checks the current file before installing the update without
replacing a competing save. A detected conflict stops setup and preserves both
versions for review. Backups also retain late saves through an editor's already
open file; compare them if you edited the config during setup. Repeated setup
that makes no change creates no backup. Symlinked target files require a manual
merge. New files are created exclusively, so setup never replaces a file that
appeared after inspection.

Use `--global` or `--local` to select where the MCP configuration is written.
For a native OpenCode setup instead, run `opencode mcp add` and choose a remote
server with the same URL. That is also suitable for demonstrating server setup
before asking the agent to connect.

The previous syntax remains a compatibility alias:

```bash
opper editors opencode --mcp
opper editors opencode --mcp --local --mcp-url http://localhost:8080/mcp
opper editors opencode --mcp --mcp-scopes 'account:read projects:read'
```

Its `--mcp-url` and `--mcp-scopes` flags correspond to `--url` and `--scopes` on
`opper mcp add opencode`. The alias still configures only MCP; `--overwrite`
remains an inference setup option.

To use Opper for both account tools and model inference, run
`opper mcp add opencode`, then `opper launch opencode`. Inference authentication
(`opper login` / `OPPER_API_KEY`) is independent of MCP browser authorization.

## Platform

Direct access to the platform endpoints:

| Command | Description |
|---------|-------------|
| `opper call <name> <instructions> [input] [--model <id>] [--stream]` | Run an Opper function. Reads input from stdin when the positional arg is omitted. |
| `opper keys create --project <uuid> --name <name> --output <path> [--mcp-url <url>]` | Approve key creation in the browser and save the secret into a new private env file. Prints only metadata. |
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

### Creating an application key without putting its secret in a conversation

```bash
opper keys create --project <project-uuid> --name 'My app' --output .env.opper
```

The command opens Opper consent for project read access and API key creation.
Choose the organization containing that project and explicitly select API key
creation. The CLI checks the project, creates one runtime key through the
delegated API, then writes `OPPER_API_KEY=...` into the new file with POSIX mode
`0600`. The parent directory must already exist. Existing files and symlinks are
never replaced, including when another process creates the destination during
browser approval. Stdout contains only the key ID, name, project UUID, and saved
path as JSON; progress and the browser URL go to stderr. Load the env file in
your application without printing or pasting it into an agent conversation.

This authorization is independent of `opper login`, `--key`, `OPPER_API_KEY`,
and OpenCode's credentials. It uses the maintained MCP SDK for discovery, public
client registration, and PKCE. Only the public client registration is retained
under `~/.opper/mcp-clients` (or `$OPPER_HOME/mcp-clients`), keyed by MCP URL and
issuer; OAuth tokens stay in memory. The temporary OAuth connection is revoked
when the operation finishes, including on errors. The application key remains
usable after that connection is revoked.

For local development, append `--mcp-url http://localhost:8080/mcp`. A production
server must have the delegated MCP/OAuth endpoints deployed before this command
can authorize. Ordinary API errors and SDK errors are sanitized, including with
`--debug`.

The CLI retries an uncertain create once with the same idempotency UUID. If the
outcome is still unknown, its error includes `--idempotency-key <uuid>`: reuse
that value only with the same project, name, MCP URL, account, organization, and
retained public client registration. Never generate another operation ID to
resolve an unknown outcome. A replay identifies the existing key but cannot
return its secret again; the CLI revokes that key and reports that a fresh
creation is needed. A failed file installation also attempts to revoke only
the newly created key. If key or connection cleanup fails, the CLI reports the
remaining action and exits with an error; an already installed env file is kept.

If a server reset or client deletion leaves the browser reporting `invalid_client`,
use `--reset-client` with a **fresh** key creation to replace only that MCP URL
and issuer's retained public registration. The next authorization needs fresh
browser consent. A token endpoint rejection also removes the rejected registration
and asks you to restart; the CLI never exchanges an old authorization code under a
new client identity. Existing OAuth grants are not revoked by resetting local
registration; manage those in Agent connections.

Do not reset a client while a previous key creation is uncertain. `--reset-client`
cannot be combined with `--idempotency-key`; recovery also refuses to register a
new identity if the original cache is missing or invalid. Restore the original
registration or reconcile the earlier key in Opper before starting a fresh create.

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
