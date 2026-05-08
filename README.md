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

`opper launch <agent>` starts a supported AI agent with its model traffic transparently routed through Opper. Pass-through args after the agent name go straight to the agent's CLI. After the session, the CLI prints a summary with duration, model, and a traces link.

```bash
opper agents list                # NAME / DISPLAY / KIND / STATE / CONFIG / COMMAND
opper launch claude              # Anthropic Messages compat → /v3/compat
opper launch claude-desktop      # rewire Claude Desktop (GUI) → /v3/compat
opper launch opencode            # OpenAI Chat Completions compat → /v3/compat
opper launch codex               # OpenAI Responses compat → /v3/compat
opper launch hermes              # OpenAI Chat Completions compat → /v3/compat
opper launch openclaw            # OpenAI Chat Completions compat → /v3/compat (background gateway)
opper launch pi                  # OpenAI Chat Completions compat → /v3/compat

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

The CLI also offers a per-agent submenu (`opper` → Agents → *agent* → Launch with model…) that lets you pick a specific Opper model from the catalog instead of the default.

To remove an agent's Opper integration without uninstalling the agent itself:

```bash
opper agents remove claude-desktop   # works for any registered adapter
```

This is the non-interactive equivalent of the menu's "Remove Opper integration" action. It clears Opper-owned config (e.g., flips Claude Desktop's `deploymentMode` back to `"1p"`, removes the `opper` provider block from OpenCode / Pi / OpenClaw, etc.) without touching anything you put there yourself.

## Ask — built-in support agent

`opper ask "<question>"` runs an Opper agent grounded on the locally-installed Opper skills (see below). Useful for "how do I…" questions about the platform, SDKs, or the CLI itself.

```bash
opper ask "how do I create an index?"
opper ask --model claude-opus-4-7 "compare the v2 and v3 APIs"
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
opper call --model claude-sonnet-4-6 myfunction "summarise" "long text…"
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

```bash
# Save to image_<ts>.png in cwd
opper image generate "a serene mountain lake at dawn"

# Specific output, specific model
opper image generate "logo concept" -o ./out/logo.png \
  -m vertexai/imagen-4.0-fast-generate-001-eu

# Print raw base64 (for piping)
opper image generate "icon" --base64 | base64 -d > icon.png
```

### Routing an agent through Opper for a one-shot job

```bash
# Pi in non-interactive mode for cron / CI
opper launch pi -p "summarise the latest PR title and body"

# Claude Code with a specific model and resumed session
opper launch claude --model claude-opus-4-7 --resume

# Codex with Sonnet for a single ask
opper launch codex --model claude-sonnet-4-6 -- "implement this feature"
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

## Source

[github.com/opper-ai/cli](https://github.com/opper-ai/cli)
