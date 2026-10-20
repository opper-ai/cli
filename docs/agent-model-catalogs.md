# Agent model discovery

Prefer the agent's own authenticated model endpoint discovery. Translate the
account's `/v3/compat/models` response only when its custom-provider integration
cannot consume that response directly. Credentials, API root and project target
must match inference; the generic `/v3/models` catalog is not an authorization
source.

## Adapter inventory

| Integration | Discovery contract | This change |
| --- | --- | --- |
| Codex CLI | Custom Responses providers do not consume standard OpenAI `/models`; Codex catalog metadata has a different schema | Temporary catalog on supported runtimes (0.153.4+), with existing native selection/config paths preserved |
| Codex Desktop | `model_catalog_json` | Filter fresh catalogs and preserve the current model and prior authorized catalog on refresh |
| OpenCode | models.dev plus explicit custom-provider models; baseURL alone does not discover account routes | Apply the same policy to agent setup/launch, editor setup and the installed login bridge |
| Pi | Custom provider `models.json` or extension registration; no generic custom `/models` discovery setting | Filter fresh catalogs and preserve authorized saved/configured selections |
| Conductor | Managed Codex catalog | Already released; unchanged |
| Hermes | Native provider `/models` discovery; local list is fallback metadata | Keep native discovery |
| Claude Code | Native protocol `/models` picker | Keep native discovery and protocol mappings |
| Copilot | Existing protocol-specific bridge | Keep its existing selection contract |
| Claude Desktop | Restricted Claude-only gateway contract | Keep its supported-model restriction |
| VS Code community Copilot extension | Native `/models` possible when configured list is absent, but treats every returned entry as tool-capable chat | Keep existing setup: Opper's response includes embeddings, so enabling raw discovery would advertise unsupported choices |
| OpenClaw | Custom provider schema requires explicit model definitions; discovery hooks are provider-specific | Requires a separate integration update: installed 2026.4.10 does not expose Opper from the CLI's current per-agent file alone |

Native endpoint preference does not mean supplying a standard OpenAI response to
an endpoint expecting a different schema, or losing model capability constraints.
For VS Code, a safe native path needs upstream capability filtering or a compatible
LLM-only endpoint contract. For OpenClaw, root provider/default-model settings and
older-version compatibility must be resolved and tested before changing discovery.
These two integrations are explicit follow-ups, not claimed as converted.

## Default and compatibility policy

For generated catalogs, fresh authenticated setups default to `pools,routes`.
`opper.kind` is authoritative, so namespaced pools remain pools and bare IDs
marked `model` remain deployments. Older responses without `kind` use the legacy
providerless-pool and `dynamic/` conventions. Existing capability/context/pricing
validation remains adapter-specific. The selected model appears first where the
agent honors catalog order, then routes, pools and retained deployments. Metadata
and exact gateway IDs remain intact.

Use `--model-kinds all` to include provider deployments:

```sh
opper launch codex --model-kinds all
opper agents configure codex-desktop --model-kinds all
opper launch opencode --model-kinds all
opper editors opencode --overwrite --model-kinds all
opper editors opencode --login-bridge --model-kinds all
opper agents configure pi --model-kinds all
```

An explicit provider model remains available without expanding the rest of the
catalog. Normal refresh also retains previously configured IDs while they remain
authorized: those IDs can back sessions or favorites outside the setup file. Thus
`pools,routes` filters newly discovered deployments on an existing broad setup;
it deliberately does not erase its older deployment entries. The installed
OpenCode bridge retains explicit `all` intent on reinstallation, and preserves
legacy bridge breadth when no policy was recorded. Discovery failure leaves
persistent setup unchanged; preservation never restores a revoked model.

OpenCode preserves main/small/agent model references, recent/favorite state,
previous catalogs, and higher-priority config layers. Native model/session/agent
arguments use the full authorized catalog so first-use explicit IDs resolve.
Pi preserves its global Opper default and configured entries; native model scopes
and session restoration delegate selection to Pi with the full authorized catalog.
Neither adapter rewrites session history.

Codex CLI leaves native profiles/config/model overrides and existing catalog
settings on their existing path. Resume/fork likewise bypass generated catalogs
and retain the prior CLI model precedence; use an explicit `--model` to continue
with a particular route/deployment. The launcher does not infer a model from
historical Codex session files. Unsupported/unknown older Codex runtimes use the
existing launch behavior. No-credential OpenCode template setup is unchanged.

## Local validation

Run the focused unit suites and `npm test`, `npm run typecheck`, `npm run build`.
Runtime fixtures use isolated homes, fake credentials and loopback HTTP:

```sh
node test/integration/opencode-catalog.mjs
node test/integration/catalog-display.mjs
node test/integration/pi-model-catalog.mjs
# Set CODEX_CATALOG_BINARY if the default bundled desktop binary is unavailable.
CODEX_CATALOG_INTEGRATION=1 node test/integration/codex-catalog.mjs
```

These exercise native model listing/model-list RPC separately from generated JSON,
plus actual agent inference, exact request model IDs, refresh and failure paths.
They do not constitute interactive TUI/desktop picker clicking, live customer
configuration tests, paid inference, production deployment or a release.

Validation snapshot (20 October 2026): 1,328 tests passed, 13 platform tests skipped;
three bundle-builder checks, TypeScript/build and packed npm installation/agent
launch smoke passed. Native workflows used Codex 0.163.0-alpha.10.2 plus the
0.147.0 legacy fallback, OpenCode 1.18.34 and Pi 1.2.0. Independent review found no
remaining actionable findings after the scoped-selection fixes. Windows-specific
skips and interactive picker UI clicking remain unverified on this macOS run.
