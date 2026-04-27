# CLI Configuration & API Keys

Manage API key configurations for the Opper CLI.

## Commands

| Command | Description |
|---------|-------------|
| `opper login` | Authenticate via OAuth device flow (recommended) |
| `opper logout` | Clear credentials for the active slot (`--all` to clear every slot) |
| `opper whoami` | Show the authenticated user for the active slot |
| `opper config list` | List all configured slots |
| `opper config add <name> <key>` | Manually store an API key in a slot |
| `opper config get <name>` | Print the API key for a slot (raw, for scripts) |
| `opper config remove <name>` | Delete a stored slot |

## Setup

```bash
# Recommended: OAuth device flow into the default slot
opper login

# Or store a key manually
opper config add default sk-your-api-key-here

# Verify
opper config list
opper whoami
```

## Multiple Environments

Store keys for different environments and switch between them with `--key`:

```bash
opper config add default sk-production-key
opper config add staging sk-staging-key
opper config add dev sk-dev-key

# Use a specific slot with any command
opper call --key staging myfunction "instructions" "input"
opper usage list --key dev
```

## Custom Base URL

For self-hosted or non-default API endpoints, set the base URL when adding the slot:

```bash
opper config add custom sk-xxx --base-url https://api.custom.com
```

`opper login` also accepts `--base-url <url>` to authenticate against a non-default Opper.

## Using Keys in Scripts

```bash
# Export a key for use in other tools
export OPPER_API_KEY=$(opper config get dev)

# Or use it inline
OPPER_API_KEY=$(opper config get production) python my_script.py
```

## Key Precedence

When the CLI resolves an API key for a request, it uses (highest priority first):

1. `OPPER_API_KEY` environment variable — overrides every slot
2. The slot named by `--key <slot>` (default: `default`)
