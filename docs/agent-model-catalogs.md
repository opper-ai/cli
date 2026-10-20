# Agent model discovery

Prefer the agent's own authenticated model endpoint discovery. Translate the
account's `/v3/compat/models` response only when its custom-provider integration
cannot consume that response directly. Credentials, API root and project target
must match inference; the generic `/v3/models` catalog is not an authorization
source.

## Adapter inventory

| Integration | Discovery contract | This change |
| --- | --- | --- |
| Codex CLI | Authenticated `model_catalog_url` with native metadata | Prefer the verified native API response; preserve user catalogs; translate only on older runtimes/servers |
| Codex Desktop | Native remote or local `model_catalog_json` | Migrate owned local catalogs after verification; retain legacy fallback |
| OpenCode | models.dev plus explicit custom-provider models; baseURL alone does not discover account routes | Apply the same policy to agent setup/launch, editor setup and the installed login bridge |
| Pi | Custom provider `models.json` or extension registration; no generic custom `/models` discovery setting | Filter fresh catalogs and preserve authorized saved/configured selections |
| Conductor | Bundled Codex native remote catalog | Prefer the verified native URL in the managed wrapper; retain legacy fallback |
| Hermes | Native provider `/models` discovery; local list is fallback metadata | Keep native discovery |
| Claude Code | Native protocol `/models` picker | Keep native discovery and protocol mappings |
| Copilot | Existing protocol-specific bridge | Keep its existing selection contract |
| Claude Desktop | Native Anthropic discovery; explicit `inferenceModels` suppresses it | Prefer verified Claude-only discovery; preserve customized lists and old app/server fallback |
| VS Code community Copilot extension | Native `/models` possible when configured list is absent, but treats every returned entry as tool-capable chat | Keep existing setup: Opper's response includes embeddings, so enabling raw discovery would advertise unsupported choices |
| OpenClaw | Custom provider schema requires explicit model definitions; discovery hooks are provider-specific | Requires a separate integration update: installed 2026.4.10 does not expose Opper from the CLI's current per-agent file alone |

Native endpoint preference does not mean supplying a standard OpenAI response to
an endpoint expecting a different schema, or losing model capability constraints.
For VS Code, a safe native path needs upstream capability filtering or a compatible
LLM-only endpoint contract. For OpenClaw, root provider/default-model settings and
older-version compatibility must be resolved and tested before changing discovery.
VS Code and OpenClaw remain explicit follow-ups, not claimed as converted.

## Native discovery configuration

Modern Codex uses a provider setting such as:

```toml
[model_providers.opper-cli]
model_catalog_url = "https://api.opper.ai/v3/compat/models?format=codex&type=pool,dynamic_route&selected_model=claude-sonnet-5"
```

The CLI verifies that native discovery is enabled in the actual Codex home and
probes this endpoint with the selected credential/project before configuring it.
Codex then refreshes the URL directly with provider authentication and project
headers. Only a valid legacy OpenAI response selects the generated fallback;
authentication, transport and malformed native-response errors stop setup.
The API preserves exact authorized IDs and tool/capability restrictions.
Unavailable selections return a uniform 400, route-store failures return 503 and
responses over Codex's 1 MiB client limit fail explicitly without truncation.

Claude Desktop has no separate catalog URL. The CLI verifies native app support
and the API response marker `X-Opper-Model-Catalog: claude-desktop` before removing
an owned name-only `inferenceModels` list. Request headers select that Claude-only
presentation, the kind policy and exact model. These headers affect listing only;
strict supported Claude IDs/pools remain enforced and routes are excluded.
The same project scope is used for discovery and inference. Customized per-model
metadata and discovery opt-outs keep their explicit lists.

These changes require the corresponding API rollout. Older servers keep the
fallback. Previously native configuration stays intact if support verification
fails. No production rollout or release is implied by these local changes.

## Default and compatibility policy

For generated and native catalogs, fresh authenticated setups default to `pools,routes`.
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
opper agents configure conductor --model-kinds all
opper agents configure claude-desktop --model-kinds all
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
in the selected Codex home and applicable host defaults, legacy managed files,
and system requirements. Catalog paths apply across providers; remote URLs are
checked for the invocation provider and any enforced provider selection. Existing
malformed or unreadable layers are left for Codex to report. Resume/fork likewise
bypass generated catalogs
and retain the prior CLI model precedence; use an explicit `--model` to continue
with a particular route/deployment. The launcher does not infer a model from
historical Codex session files. Unsupported/unknown older Codex runtimes use the
existing launch behavior. No-credential OpenCode template setup is unchanged.

Existing local Codex catalogs migrate to native `all` conservatively so saved
provider selections cannot disappear. Broad native policy stays broad; changing a
narrow native selection also broadens it to preserve the prior selection. Claude
Desktop upgrades from an existing explicit list also use `all`.

## Local validation

Run the focused unit suites and `npm test`, `npm run typecheck`, `npm run build`.
Runtime fixtures use isolated homes, fake credentials and loopback HTTP:

```sh
node test/integration/opencode-catalog.mjs
node test/integration/catalog-display.mjs
node test/integration/pi-model-catalog.mjs
# Set CODEX_CATALOG_BINARY if the default bundled desktop binary is unavailable.
CODEX_CATALOG_INTEGRATION=1 node test/integration/codex-catalog.mjs
CONDUCTOR_INTEGRATION=1 node test/integration/conductor.mjs
node test/integration/claude-desktop-catalog.mjs
```

These exercise native model listing/model-list RPC separately from generated JSON,
plus actual agent inference, exact request model IDs, refresh and failure paths.
They do not constitute interactive TUI/desktop picker clicking, live customer
configuration tests, paid inference, production deployment or a release.

The API opt-in runtime test uses production catalog and Responses handlers with
only the provider adapter mocked. Run `OPPER_NATIVE_CODEX_INTEGRATION=1 go test
./internal/handler -run '^TestCodexNativeCatalogRuntime$' -count=1 -v` in task-api.
Claude Desktop automated fixtures use its installed discovery/parser functions;
they do not open the app or perform inference. The separate manual desktop smoke
below covers the real macOS UI. Windows native runtime workflows remain unverified.

### Manual desktop smoke, 20 October 2026

The user operated the installed signed Codex/ChatGPT and Claude Desktop apps in
fresh temporary profiles and confirmed both worked. Gateway logs independently
confirmed native catalog requests and successful real Opper inference for both
`claude-haiku-4-5` and `aws/claude-haiku-4-5-eu` in each app.

- Codex fetched `format=codex` itself with `client_version=0.163.0` and completed
  pool and exact-provider requests through `/v3/compat/responses`.
- Claude Desktop fetched the acknowledged Claude-only catalog and completed pool
  and exact-provider requests through `/v3/compat/v1/messages`.
- The local gateway used the production catalog handlers with an authorized live
  Claude pool snapshot. Inference went to the real Opper gateway and providers;
  the selected provider ID was preserved, while the pool chose an eligible member.
- The fixture deliberately rejected a separate Codex background request for
  `gpt-6-luna`, outside its two-model allowance. That request never reached Opper.
  Background model generation was not part of this smoke test.
- Normal Codex settings and Claude gateway/profile files matched their pre-test
  hashes, and the original app processes remained running. A later cleanup check
  observed a rewrite of normal Claude's general `config.json`, which contains
  runtime cache/updater state; it was left intact. The isolated profiles used
  separate state, disabled shortcuts/updaters, and synthetic client credentials.

This verifies the desktop discovery/picker/inference path before rollout. It does
not imply the new native response format has been deployed or the CLI released.


## Native discovery audit

A follow-up runtime check corrected the initial broad claim that custom Codex
providers cannot discover remotely. Codex 0.162.1 (Conductor) and 0.163 (Desktop)
fetch an explicit `model_catalog_url` directly with provider authentication,
project headers and `client_version`. No local catalog file is needed. Standard
Opper `{data:[...]}` produced an empty picker; the same endpoint returning full
Codex `{models:[...]}` metadata populated it. Codex 0.147 ignored the URL.
The API change adds that format to the existing endpoint. Setting the URL to the
standard model list without `format=codex` remains insufficient. See the
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
- Claude Desktop's native conversion uses the filtered API profile. Customized
  lists and older app/server setups retain the explicit fallback.
- VS Code's community extension supports native discovery, but module-level runtime
  checks confirmed it advertises embeddings as tool/image-capable chat models.
- OpenClaw's built-in vLLM/SGLang and provider-plugin discovery are specialized;
  renaming the existing `opper` provider would break saved identities.
- Copilot's pinned 1.0.88 BYOK contract uses an explicit registry; no generic native
  discovery option was found. Its binary was not installed for this audit.

These checks keep built-in endpoint polling, plugin callbacks and CLI catalog
translation distinct. The audit informed the native conversions described above.
