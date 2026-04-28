---
name: opper-cli
description: >
  Use the Opper CLI for terminal-based AI task completion, function management, knowledge base operations, model configuration, trace inspection, image generation, and usage analytics. Activate when users want to call Opper functions from the command line, manage indexes, inspect traces, track costs, or wire local code editors and agents through Opper.
---

# Opper CLI

Command-line interface for the Opper platform. Call functions, manage knowledge bases, configure models, inspect traces, generate images, and route AI agents and code editors through Opper from your terminal.

## Installation

```bash
npm install -g @opperai/cli
```

After install, verify with `opper --version`. (The package installs an `opper` binary.)

## Authentication

Authenticate via the OAuth device flow:

```bash
opper login
```

Or store an API key directly:

```bash
opper config add default <your-api-key>
```

Verify the active slot:

```bash
opper whoami
```

Use multiple slots with the `--key` flag:

```bash
opper config add staging <staging-api-key>
opper call --key staging myfunction "instructions" "input"
```

## Core Command: `call`

Execute an Opper function from the terminal:

```bash
# Basic call
opper call myfunction "respond in kind" "what is 2+2?"

# With a specific model
opper call --model anthropic/claude-sonnet-4.6 myfunction "summarize this" "long text..."

# Pipe input from stdin
echo "what is 2+2?" | opper call myfunction "respond in kind"

# Stream the response
opper call --stream myfunction "instructions" "input"
```

## Commands Overview

| Command | Description |
|---------|-------------|
| `call` | Execute a function with instructions and input |
| `functions` | List, get, delete functions |
| `indexes` | Manage knowledge base indexes (list, get, create, delete, add, query) |
| `models` | Register, list, get, delete custom models |
| `traces` | List, get, delete execution traces |
| `usage` | Token usage and cost analytics |
| `image` | Generate images from a prompt |
| `config` | Manage stored API keys (add, list, get, remove) |
| `login` / `logout` / `whoami` | Authenticate and inspect the active slot |
| `editors` | Configure Opper as a provider in OpenCode and Continue.dev |
| `agents` / `launch` | Route supported AI agents (e.g. Hermes, Claude Code, Codex) through Opper |
| `skills` | Install, update, list, uninstall bundled Opper skills |
| `version` | Print the CLI version |

Run `opper <command> --help` for full flags on any subcommand.

## Model Management

Register custom models (uses LiteLLM identifiers):

```bash
# Register an Azure-deployed model
opper models create my-gpt4 azure/my-gpt4-deployment my-api-key '{"api_base": "https://my.openai.azure.com", "api_version": "2024-02-01"}'

# List models (optional substring filter)
opper models list claude

# Get details of a model
opper models get my-gpt4

# Delete a model
opper models delete my-gpt4
```

## Image Generation

```bash
# Save to image_<timestamp>.png in cwd
opper image generate "a serene mountain lake at dawn"

# Specify output path
opper image generate "logo concept" -o ./out/logo.png

# Print raw base64 (for piping)
opper image generate "icon" --base64 > img.b64

# Override the model
opper image generate "..." -m gcp/imagen-4.0-fast-generate-001-eu
```

## Usage Tracking

```bash
# Usage for a date range grouped by model
opper usage list --from-date=2026-04-01 --to-date=2026-04-30 --fields=total_tokens --group-by=model

# Time-precise query (RFC3339 format)
opper usage list --from-date=2026-04-27T14:00:00Z --to-date=2026-04-27T16:00:00Z --granularity=minute

# Export as CSV
opper usage list --out=csv
```

`cost` and `count` are always included automatically. Valid `--fields` values: `total_tokens`, `prompt_tokens`, `completion_tokens`. Do NOT pass `count` as a field.

## Editor & Agent Integration

Route a local AI editor through Opper:

```bash
opper editors list
opper editors opencode --overwrite
opper editors continue --overwrite
```

Launch an agent with inference routed through Opper:

```bash
opper agents list
opper launch hermes
opper launch claude-code -- --some-flag passed through
```

Anything after the agent name is forwarded to the agent's CLI verbatim.

## Global Flags

| Flag | Description |
|------|-------------|
| `--key <slot>` | API key slot to use (default: `default`) |
| `--debug` | Enable diagnostic output |
| `--no-telemetry` | Disable anonymous telemetry |
| `--no-color` | Disable ANSI colors |
| `-v, --version` | Print CLI version |
| `-h, --help` | Show help for any command |

## Common Mistakes

- **Missing config**: Run `opper login` (or `opper config add default <key>`) before using API-bound commands.
- **Wrong argument order for `call`**: It's `opper call <function> <instructions> <input>`, not `opper call <instructions> <function> <input>`.
- **Model identifiers**: Use LiteLLM format (`azure/deployment-name`, `anthropic/claude-sonnet-4.6`), not raw model names.
- **`indexes add` content**: Content is a positional argument, not a `--content` flag. Pass `-` to read from stdin.

## Additional Resources

- For function management details, see [references/FUNCTIONS.md](references/FUNCTIONS.md)
- For index/knowledge base operations, see [references/INDEXES.md](references/INDEXES.md)
- For usage analytics and cost tracking, see [references/USAGE.md](references/USAGE.md)
- For API key configuration, see [references/CONFIG.md](references/CONFIG.md)

## Related Skills

- **opper-api**: Use when you need the full REST API reference for HTTP-based integrations.
- **opper-python-sdk**: Use when building Python applications with the Opper SDK.
- **opper-node-sdk**: Use when building TypeScript applications with the Opper SDK.

## Upstream Sources

When this skill's content may be outdated, resolve using this priority:

1. **Installed CLI** — run `opper --help` and `opper <command> --help`
2. **Source code** — https://github.com/opper-ai/cli
