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

### Auth
- `opper login` — Authenticate via the OAuth device flow.
- `opper logout` — Clear stored credentials.
- `opper whoami` — Show the authenticated user for the active slot.

### Skills
- `opper skills install` — Install the Opper skill pack via `npx skills`.
- `opper skills update` — Update the installed skills.
- `opper skills list` — Show whether Opper skills are installed.

### Editor integrations
- `opper editors list` — List supported editors and which can be auto-configured.
- `opper editors opencode [--global|--local] [--overwrite]` — Write the Opper provider into OpenCode's config.
- `opper editors continue [--global|--local] [--overwrite]` — Write Opper models into Continue.dev's config.

### Agents
- `opper agents list` — List supported AI agents and whether each is installed.
- `opper launch <agent> [--model <id>] [--install] [-- <agent args>]` — Launch a supported agent with its inference routed through Opper. Snapshots the agent's config on entry, restores it on exit.

### Wizards
- `opper setup` — Interactive wizard that ties the above together.

### Misc
- `opper version` — Print the CLI version.

## Requirements

- Node.js ≥20.10
