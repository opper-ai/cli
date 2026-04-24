# CLI Configuration & API Keys

Manage API key configurations for the Opper CLI.

## Commands

| Command | Description |
|---------|-------------|
| `opper config list` | List all configured API keys |
| `opper config add <name> <key>` | Add a new API key |
| `opper config get <name>` | Get an API key value |
| `opper config remove <name>` | Remove an API key |

## Setup

```bash
# Add your default API key
opper config add default sk-your-api-key-here

# Verify it's configured
opper config list
```

## Multiple Environments

Store keys for different environments and switch between them:

```bash
# Add keys for different environments
opper config add default sk-production-key
opper config add staging sk-staging-key
opper config add dev sk-dev-key

# Use a specific key with any command
opper call --key staging myfunction "instructions" "input"
opper usage list --key dev
```

## Custom Base URL

For self-hosted or custom API endpoints:

```bash
# Add key with custom base URL
opper config add custom sk-xxx --base-url https://api.custom.com
```

## Using Keys in Scripts

```bash
# Export a key for use in other tools
export OPPER_API_KEY=$(opper config get dev)

# Use in a script
OPPER_API_KEY=$(opper config get production) python my_script.py
```

## Key Precedence

1. `--key <name>` flag on any command (highest priority)
2. `OPPER_API_KEY` environment variable
3. `default` configuration
