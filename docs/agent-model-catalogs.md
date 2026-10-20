# Agent model discovery

Prefer the agent's own authenticated model endpoint discovery. Translate the
account's `/v3/compat/models` response only when its custom-provider integration
cannot consume that response directly. Credentials, API root and project target
must match inference; the generic `/v3/models` catalog is not an authorization
source.

## Adapter inventory

| Integration | Discovery contract | This change |
| --- | --- | --- |
| Codex CLI | Modern runtimes support authenticated `model_catalog_url`; the response must contain Codex metadata, not standard OpenAI model rows | Preserve configured native URL/local catalogs; temporary translated catalog only on the fallback path |
| Codex Desktop | Supports native remote catalogs and local `model_catalog_json`; current Opper setup supplies a local catalog | Filter fresh catalogs and preserve the current model and prior authorized catalog on refresh |
| OpenCode | models.dev plus explicit custom-provider models; baseURL alone does not discover account routes | Apply the same policy to agent setup/launch, editor setup and the installed login bridge |
| Pi | Custom provider `models.json` or extension registration; no generic custom `/models` discovery setting | Filter fresh catalogs and preserve authorized saved/configured selections |
| Conductor | Bundled Codex supports native remote catalogs; released wrapper supplies a local catalog | Already released; unchanged |
| Hermes | Native provider `/models` discovery; local list is fallback metadata | Keep native discovery |
| Claude Code | Native protocol `/models` picker | Keep native discovery and protocol mappings |
| Copilot | Existing protocol-specific bridge | Keep its existing selection contract |
| Claude Desktop | Native gateway discovery exists, but explicit `inferenceModels` overrides it; current adapter pins that list | Preserve current restriction; native adaptation remains a follow-up |
| VS Code community Copilot extension | Native `/models` possible when configured list is absent, but treats every returned entry as tool-capable chat | Keep existing setup: Opper's response includes embeddings, so enabling raw discovery would advertise unsupported choices |
| OpenClaw | Custom provider schema requires explicit model definitions; discovery hooks are provider-specific | Requires a separate integration update: installed 2026.4.10 does not expose Opper from the CLI's current per-agent file alone |

Native endpoint preference does not mean supplying a standard OpenAI response to
an endpoint expecting a different schema, or losing model capability constraints.
For VS Code, a safe native path needs upstream capability filtering or a compatible
LLM-only endpoint contract. For OpenClaw, root provider/default-model settings and
older-version compatibility must be resolved and tested before changing discovery.
These integrations are explicit follow-ups, not claimed as converted. Claude Desktop is also a native-discovery candidate: its current explicit list suppresses discovery, and a conversion must preserve saved choices and supported model restrictions.

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
settings on their existing path, including `model_providers.opper-cli.model_catalog_url`
in the selected Codex home. Remote URLs inherited only from system/managed configuration
were not exercised by this local-file detection test. Resume/fork likewise bypass generated catalogs
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


## Native discovery audit

A follow-up runtime check corrected the initial broad claim that custom Codex
providers cannot discover remotely. Codex 0.162.1 (Conductor) and 0.163 (Desktop)
fetch an explicit `model_catalog_url` directly with provider authentication,
project headers and `client_version`. No local catalog file is needed. Standard
Opper `{data:[...]}` produced an empty picker; the same endpoint returning full
Codex `{models:[...]}` metadata populated it. Codex 0.147 ignored the URL.
The API repository's inspected `origin/main` does not expose that Codex catalog
format. The preferred future native path therefore needs a compatible API endpoint;
setting the URL to today's standard model list is insufficient. See the
[official remote catalog contract](https://learn.chatgpt.com/docs/enterprise/roll-out-a-gateway#serve-a-remote-catalog).

The baseline CLI already preserved a configured native URL. The fallback initially
overrode it with a higher-precedence local catalog; the regression is repaired and
covered by a failing-then-passing unit test plus actual native URL/picker/inference
checks. Focused verification after repair: 141 tests, typecheck/build, independent
review and the real Codex integration passed.

Other harness details:

- OpenCode's installed login bridge already fetches directly inside OpenCode.
  Generic provider configuration in 1.18.34 has no authenticated discovery URL;
  its models.dev URL option is a different unauthenticated schema. OpenCode 2 has
  provider-specific discovery, but no safe generic Opper configuration switch was found.
- Pi 1.2.0 supports provider-extension `refreshModels` callbacks, not a generic
  custom-provider catalog URL. The current extension registers the CLI-generated catalog.
- Hermes already uses direct authenticated discovery. Claude Code also does, but
  its native picker restricts IDs to Claude/Anthropic names, including route names.
- Claude Desktop supports native discovery. Its explicit `inferenceModels` takes
  precedence, and our current setup pins that list. Native conversion remains unimplemented.
- VS Code's community extension supports native discovery, but module-level runtime
  checks confirmed it advertises embeddings as tool/image-capable chat models.
- OpenClaw's built-in vLLM/SGLang and provider-plugin discovery are specialized;
  renaming the existing `opper` provider would break saved identities.
- Copilot's pinned 1.0.88 BYOK contract uses an explicit registry; no generic native
  discovery option was found. Its binary was not installed for this audit.

These checks keep built-in endpoint polling, plugin callbacks and CLI catalog
translation distinct. No backend changes or native conversions were made in the audit.
