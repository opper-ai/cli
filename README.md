# opper

The official Opper CLI — authenticate, route agent inference, and manage the Opper platform.

## Quick start

```bash
npx opper login
npx opper whoami
```

## Install globally

```bash
npm i -g opper
opper --help
```

## Commands

- `opper login` — Authenticate via the OAuth device flow.
- `opper logout` — Clear stored credentials.
- `opper whoami` — Show the authenticated user for the active slot.
- `opper version` — Print the CLI version.

More commands (agent launch, setup wizard, call, models) are shipping soon.

## Requirements

- Node.js ≥20.10
