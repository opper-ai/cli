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
- `opper config add <name> <api-key> [--base-url <url>]` — Manually store an API key.
- `opper config list` — List configured slots.
- `opper config get <name>` — Print the raw API key for scripting.
- `opper config remove <name>` — Delete a stored slot.

### Platform
- `opper call <name> <instructions> [input] [--model <id>] [--stream]` — Execute a function via the v3 /call endpoint. Reads input from stdin if the positional arg is omitted.
- `opper models list [filter]` — List available models.
- `opper functions list [filter]` — List cached functions.
- `opper functions get <name>` — Show details of a function.
- `opper functions delete <name>` — Delete a cached function.
- `opper traces list [--limit <n>] [--offset <n>] [--name <substring>]` — List traces.
- `opper traces get <id>` — Show a trace and its spans.
- `opper traces delete <id>` — Delete a trace.

### Knowledge / indexes
- `opper indexes list [--limit <n>] [--offset <n>]` — List indexes.
- `opper indexes get <name>` — Show details of an index.
- `opper indexes create <name> [--embedding-model <id>]` — Create an index.
- `opper indexes delete <name>` — Delete an index.
- `opper indexes query <name> <query> [--top-k <n>] [--filters <json>]` — Semantic search.
- `opper indexes add <name> <content> [--key <id>] [--metadata <json>]` — Add a document.

### Custom models
- `opper models create <name> <identifier> <apiKey> [--extra <json>]` — Register a custom model.
- `opper models get <name>` — Show details of a custom model.
- `opper models delete <name>` — Remove a custom model.

### Usage analytics
- `opper usage list [--from-date] [--to-date] [--granularity] [--fields] [--group-by] [--out csv]` — Query usage rows.

### Image generation
- `opper image generate <prompt> [-o <file>] [--base64] [-m <model>]` — Generate an image.

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
- `opper launch <agent> [--model <id>] [--install] [-- <agent args>]` — Launch a supported agent with its inference routed through Opper.

### Wizards
- `opper setup` — Interactive wizard.

### Misc
- `opper version` — Print the CLI version.

## Requirements

- Node.js ≥20.10
