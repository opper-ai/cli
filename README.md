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

Run `opper` with no arguments for an interactive menu (Account · Agents · Skills · Opper). The menu also offers quick-launch shortcuts for any agent that's already installed and configured.

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

`opper launch <agent>` starts a supported AI agent with its model traffic transparently routed through Opper. Pass-through args after the agent name go straight to the agent's CLI.

```bash
opper agents list            # NAME / DISPLAY / KIND / STATE / CONFIG / COMMAND
opper launch claude          # Anthropic Messages compat → /v3/compat
opper launch opencode        # OpenAI Chat Completions compat → /v3/compat
opper launch codex           # OpenAI Responses compat → /v3/compat
opper launch hermes          # OpenAI Chat Completions compat → /v3/compat
opper launch pi              # OpenAI Chat Completions compat → /v3/compat
```

| Agent | Slug | How Opper plugs in |
|-------|------|--------------------|
| Claude Code | `claude` | `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` env vars |
| OpenCode | `opencode` | provider block in `~/.config/opencode/opencode.json` |
| Codex | `codex` | sentinel-managed `[model_providers.opper]` + `[profiles.opper-opus]` block in `~/.codex/config.toml` |
| Hermes | `hermes` | isolated `HERMES_HOME=~/.opper/hermes-home/` so your real `~/.hermes/` is never touched; `OPENAI_API_KEY` env var |
| Pi | `pi` | `opper` provider entry in `~/.pi/agent/models.json` (added/removed idempotently next to your other providers) |

`opper launch <agent> --install` runs the upstream agent's installer if it's missing (where supported).

## Skills

Bundled "skills" are markdown SKILL.md docs that drop into `~/.claude/skills/` and `~/.codex/skills/`. The Codex install also wires each skill into a managed `[[skills.config]]` sentinel block in `~/.codex/config.toml`.

```bash
opper skills list                                # per-skill matrix across targets
opper skills install                             # install all bundled skills
opper skills install opper-cli opper-python-sdk  # install a subset
opper skills update                              # refresh installed skills
opper skills uninstall opper-api                 # remove specific skills
```

The interactive menu offers a multi-select picker for install / uninstall.

## Editor integrations

```bash
opper editors list
opper editors opencode  [--global|--local] [--overwrite]   # also exposed as `opper launch opencode`
opper editors continue  [--global|--local] [--overwrite]
```

## Platform

Direct access to the v3 platform endpoints:

| Command | Description |
|---------|-------------|
| `opper call <name> <instructions> [input] [--model <id>] [--stream]` | Run an Opper function. Reads input from stdin when the positional arg is omitted. |
| `opper functions list [filter]` / `get <name>` / `delete <name>` | Manage functions. |
| `opper models list [filter]` | List available models (built-in + custom). |
| `opper models create <name> <identifier> <apiKey> [--extra <json>]` | Register a custom LiteLLM-compatible model. |
| `opper models get <name>` / `delete <name>` | Inspect / remove a custom model. |
| `opper indexes list [--limit] [--offset]` | List knowledge-base indexes. |
| `opper indexes get <name>` / `create <name> [--embedding-model <id>]` / `delete <name>` | Manage indexes. |
| `opper indexes add <name> <content> [--key <id>] [--metadata <json>]` | Add a document (`<content>` accepts `-` for stdin). |
| `opper indexes query <name> <query> [--top-k <n>] [--filters <json>]` | Semantic search. |
| `opper traces list [--limit] [--offset] [--name <substring>]` | List traces. |
| `opper traces get <id>` / `delete <id>` | Inspect / remove a trace. |
| `opper usage list [--from-date] [--to-date] [--granularity] [--fields] [--group-by] [--out csv]` | Token / cost analytics. |
| `opper image generate <prompt> [-o <file>] [--base64] [-m <model>]` | Generate an image. |

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
