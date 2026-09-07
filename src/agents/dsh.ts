import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { writeFile, mkdir, chmod, rm } from "node:fs/promises";
import { Document, isCollection, isMap, isScalar, parseDocument } from "yaml";
import { which } from "../util/which.js";
import { run } from "../util/run.js";
import { OpperError } from "../errors.js";
import { npmInstallGlobal } from "./npm-install.js";
import { OPPER_COMPAT_URL } from "../config/endpoints.js";
import { DEFAULT_MODELS, pickerModelsForLaunch } from "../config/models.js";
import { withYamlKeys, readYamlDoc, readYamlDocOrNull } from "../util/config-snapshot.js";
import type {
  AgentAdapter,
  ConfigureOptions,
  DetectResult,
  OpperRouting,
} from "./types.js";

// DeepSeek Harness settings are namespaced per plugin. `llm-pi-ai` is the
// multi-provider adapter's section (`@deepseek-ai/dsh-llm-pi-ai`) — the same
// document its Models page writes — and `agent-default-model` is the model
// new sessions start on. We own one route inside the first and, for the
// duration of a launch, the whole of the second; every other section in the
// file is the user's and is left alone.
const PROVIDER_SECTION = "llm-pi-ai";
const DEFAULT_MODEL_SECTION = "agent-default-model";
const PROVIDER_KEY = "opper";

/**
 * dsh resolves a route's key through a *credential reference* — an env var
 * name — never a literal in the settings file. Precedence is inherited env >
 * `.credentials.yaml` > `.env`, so exporting this at spawn keeps the session
 * key out of every file on disk while still winning over a stored one.
 */
const CREDENTIAL_REF = "OPPER_API_KEY";

function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}
function settingsPath(): string {
  return join(dshHome(), "settings.yaml");
}
function credentialsPath(): string {
  return join(dshHome(), ".credentials.yaml");
}

interface ProviderRoute {
  displayName: string;
  apiKeyEnv: string;
  api: string;
  baseURL: string;
  compat: Record<string, unknown>;
  headers?: Record<string, string>;
  models: Array<{ id: string; contextWindow: number }>;
}

function opperRoute(
  baseUrl: string,
  launchModel: string,
  sessionId?: string,
): ProviderRoute {
  // Opper validates a trace id as a bare UUID, so the `sess_` prefix comes
  // off; the affinity headers take the session id as it stands.
  const traceId = sessionId?.startsWith("sess_") ? sessionId.slice(5) : sessionId;
  return {
    displayName: "Opper",
    apiKeyEnv: CREDENTIAL_REF,
    api: "openai-completions",
    baseURL: baseUrl,
    // pi-ai picks a request shape from the endpoint's URL and addresses one it
    // doesn't recognise as if it were OpenAI itself: a reasoning model's system
    // prompt goes out as `role: "developer"` and the output cap as
    // `max_completion_tokens`. Opper's compat endpoint speaks classic Chat
    // Completions, so pin both switches rather than let detection guess.
    //
    // `cacheControlFormat` is the same story and costs real money: OpenAI's
    // implicit prompt caching is what pi-ai assumes for an unrecognised
    // endpoint, and Opper does none — two identical 20k-token requests each
    // bill in full. Anthropic-style markers on the system prompt, the last
    // tool definition, and the last message turn a repeat prefix into a cache
    // read (~90% cheaper measured against /v3/compat). Models on the route
    // that aren't Anthropic-backed accept the marker and ignore it.
    compat: {
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      cacheControlFormat: "anthropic",
    },
    // Cache markers only pay off if consecutive turns reach the same upstream:
    // a cache written on one provider is a miss on the next. The X-Opper pair
    // carrying one value is what pins a session to a provider (the same pair
    // `opper launch pi` ships in its extension), and because parent == trace
    // they also give the launch a session root span to render a trace from.
    //
    // Alongside them go the three names other gateways use for the same job.
    // pi-ai can emit these per conversation from dsh's own session id, but
    // only behind `sendSessionAffinityHeaders`, a switch dsh's plugin does not
    // accept — it refuses the whole route with NO_ADAPTER. Static headers are
    // what is left: same names, launch-wide value. Names the gateway ignores
    // cost nothing.
    ...(traceId && sessionId
      ? {
          headers: {
            "X-Opper-Trace-Id": traceId,
            "X-Opper-Parent-Span-Id": traceId,
            session_id: sessionId,
            "x-client-request-id": sessionId,
            "x-session-affinity": sessionId,
          },
        }
      : {}),
    // A hand-declared route replaces the catalog wholesale, so a model missing
    // from this list fails with UNKNOWN_MODEL — pickerModelsForLaunch is what
    // gets a non-curated `--model <id>` into it.
    models: pickerModelsForLaunch(launchModel).map((m) => ({
      id: m.id,
      contextWindow: m.contextWindow,
    })),
  };
}

/**
 * Apply `entries` to settings.yaml through the Document API — the user's
 * comments, key order, and quoting survive, and missing parents are created.
 */
async function patchSettings(entries: Array<[string[], unknown]>): Promise<void> {
  const path = settingsPath();
  const doc = readYamlDocOrNull(path);
  // Same rule as the credential store below: a document we cannot read is
  // not an empty one. dsh's own docs tell users to hand-edit this file, so a
  // syntax slip is the expected failure — and writing our route over it would
  // take their providers, MCP servers and settings with it.
  if (doc === null) {
    throw new OpperError(
      "AGENT_CONFIG_CONFLICT",
      `Could not parse ${path}`,
      "Fix or remove that file and try again — refusing to overwrite settings that can't be read.",
    );
  }
  for (const [keyPath, value] of entries) doc.setIn(keyPath, value);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, doc.toString());
}

// `.credentials.yaml` is a *versioned* document — `version: 1`, with credential
// references nested under `refs:` beside the `records:` dsh writes for OAuth
// sign-ins — and it rejects an unknown top-level key outright rather than
// skipping it. A bare `OPPER_API_KEY:` at the root is the pre-release flat
// layout, which dsh tolerates only by migrating the whole file at boot; our ref
// written beside flat entries is exactly the mix it refuses, so we migrate too.
const CREDENTIALS_VERSION = 1;
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse the credential store, or null when it can't be read. Unlike settings,
 * an unparseable file here is never treated as empty — overwriting it would
 * destroy secrets we can't see — so each caller decides what to do instead.
 */
function readCredentialsDoc(path: string): Document | null {
  if (!existsSync(path)) return new Document({});
  const doc = parseDocument(readFileSync(path, "utf8"), { uniqueKeys: true });
  if (doc.errors.length > 0) return null;
  if (doc.contents === null) return new Document({});
  return isMap(doc.contents) ? doc : null;
}

/**
 * Nest a pre-release flat document under `refs:` the way dsh's own boot
 * migration does — every line indented two spaces, so comments, blank lines,
 * and each value's spelling survive byte for byte. Null for anything its
 * recognizer would decline: dsh rejects such a file loudly and names the
 * problem better than we could guess at it.
 */
function migrateFlatCredentials(text: string): string | null {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0 || !isMap(doc.contents) || doc.contents.items.length === 0) {
    return null;
  }
  for (const line of text.split("\n")) {
    if (/^(%|---|\.\.\.)/.test(line)) return null;
  }
  for (const pair of doc.contents.items) {
    const key = isScalar(pair.key) ? pair.key.value : undefined;
    if (typeof key !== "string" || key === "version" || !CREDENTIAL_REF_PATTERN.test(key)) {
      return null;
    }
    const value = isScalar(pair.value) ? pair.value.value : undefined;
    if (typeof value !== "string" || value.length === 0) return null;
  }
  const indented = text
    .split("\n")
    .map((line) => (line.length === 0 ? line : `  ${line}`))
    .join("\n");
  return `version: ${CREDENTIALS_VERSION}\nrefs:\n${indented}${text.endsWith("\n") ? "" : "\n"}`;
}

/**
 * dsh refuses on POSIX to read a credential store carrying any group or other
 * permission bit, and writeFile leaves a pre-existing file's mode alone — so
 * pin 0600 (under a 0700 home) on every write.
 */
async function writeCredentials(path: string, doc: Document): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, doc.toString(), { mode: 0o600 });
  await chmod(path, 0o600);
}

async function setCredential(apiKey: string): Promise<void> {
  const path = credentialsPath();
  let doc = readCredentialsDoc(path);
  if (doc === null) {
    throw new OpperError(
      "AGENT_CONFIG_CONFLICT",
      `Could not parse ${path}`,
      "Fix or remove that file and try again — refusing to overwrite a credential store that can't be read.",
    );
  }
  if (existsSync(path) && doc.getIn(["version"]) === undefined) {
    const migrated = migrateFlatCredentials(readFileSync(path, "utf8"));
    if (migrated !== null) doc = parseDocument(migrated);
  }
  doc.setIn(["version"], CREDENTIALS_VERSION);
  doc.setIn(["refs", CREDENTIAL_REF], apiKey);
  await writeCredentials(path, doc);
}

async function clearCredential(): Promise<void> {
  const path = credentialsPath();
  if (!existsSync(path)) return;
  const doc = readCredentialsDoc(path);
  if (doc === null) return;
  // Ours sits under `refs:` in a versioned document and at the root in a
  // pre-release one. Removing it doesn't force the migration — dsh does that
  // at its next boot, and a removal has no business rewriting what it didn't
  // put there.
  const keyPath = doc.getIn(["version"]) === undefined
    ? [CREDENTIAL_REF]
    : ["refs", CREDENTIAL_REF];
  if (doc.getIn(keyPath) === undefined) return;
  doc.deleteIn(keyPath);
  const refs = doc.getIn(["refs"]);
  if (isCollection(refs) && refs.items.length === 0) doc.deleteIn(["refs"]);
  // A bare `version:` (or nothing at all) is a store holding no credentials;
  // an absent file says the same without leaving a husk behind.
  const remaining = isMap(doc.contents)
    ? doc.contents.items.filter((p) => !(isScalar(p.key) && p.key.value === "version"))
    : [];
  if (remaining.length === 0) {
    await rm(path, { force: true });
    return;
  }
  await writeCredentials(path, doc);
}

async function detect(): Promise<DetectResult> {
  const path = await which("dsh");
  if (!path) return { installed: false };

  const versionResult = run("dsh", ["--version"]);
  const versionMatch = versionResult.code === 0
    ? versionResult.stdout.match(/v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/)
    : null;
  const parsed = versionMatch ? versionMatch[1] : undefined;

  return {
    installed: true,
    ...(parsed ? { version: parsed } : {}),
    configPath: settingsPath(),
  };
}

async function install(): Promise<void> {
  await npmInstallGlobal(
    "@deepseek-ai/dsh",
    "https://github.com/deepseek-ai/deepseek-harness",
  );
}

async function isConfigured(): Promise<boolean> {
  const doc = readYamlDoc(settingsPath());
  return doc.getIn([PROVIDER_SECTION, "providers", PROVIDER_KEY]) !== undefined;
}

async function configure(opts: ConfigureOptions): Promise<void> {
  if (!opts.apiKey) {
    throw new OpperError(
      "AUTH_REQUIRED",
      "DeepSeek Harness configuration needs an Opper API key.",
      "Run `opper login` first, or set OPPER_API_KEY.",
    );
  }
  await setCredential(opts.apiKey);
  await patchSettings([
    [
      [PROVIDER_SECTION, "providers", PROVIDER_KEY],
      opperRoute(OPPER_COMPAT_URL, DEFAULT_MODELS.opus),
    ],
    [
      [DEFAULT_MODEL_SECTION],
      { provider: PROVIDER_KEY, model: DEFAULT_MODELS.opus },
    ],
  ]);
}

async function unconfigure(): Promise<void> {
  const path = settingsPath();
  if (existsSync(path)) {
    const doc = readYamlDoc(path);
    let changed = false;
    if (doc.getIn([PROVIDER_SECTION, "providers", PROVIDER_KEY]) !== undefined) {
      doc.deleteIn([PROVIDER_SECTION, "providers", PROVIDER_KEY]);
      for (const parent of [[PROVIDER_SECTION, "providers"], [PROVIDER_SECTION]]) {
        const node = doc.getIn(parent);
        if (isCollection(node) && node.items.length === 0) doc.deleteIn(parent);
      }
      changed = true;
    }
    // Only ours to remove — a default pointing at another provider is the
    // user's own selection and survives.
    if (doc.getIn([DEFAULT_MODEL_SECTION, "provider"]) === PROVIDER_KEY) {
      doc.deleteIn([DEFAULT_MODEL_SECTION]);
      changed = true;
    }
    if (changed) await writeFile(path, doc.toString());
  }
  await clearCredential();
}

async function spawn(args: string[], routing: OpperRouting): Promise<number> {
  // Snapshot just our route and the default-model section so a direct `dsh`
  // run after the launch doesn't inherit this session's URL, while everything
  // the user (or the harness itself) changes mid-session — other providers,
  // stored credentials, settings written from the web UI — survives.
  return withYamlKeys(
    settingsPath(),
    [[PROVIDER_SECTION, "providers", PROVIDER_KEY], [DEFAULT_MODEL_SECTION]],
    async () => {
      await patchSettings([
        [
          [PROVIDER_SECTION, "providers", PROVIDER_KEY],
          opperRoute(routing.baseUrl, routing.model, routing.sessionId),
        ],
        [
          [DEFAULT_MODEL_SECTION],
          { provider: PROVIDER_KEY, model: routing.model },
        ],
      ]);

      // `dsh web` is the harness's own front door — the local browser UI, which
      // auto-initialises its profile on first use. Pass-through args take over
      // so the other shipped profiles run through Opper too:
      //   opper launch dsh -- --profile headless "run the tests"
      const finalArgs = args.length === 0 ? ["web"] : args;
      const result = run("dsh", finalArgs, {
        inherit: true,
        env: { ...process.env, [CREDENTIAL_REF]: routing.apiKey },
      });
      return result.code;
    },
  );
}

export const dsh: AgentAdapter = {
  name: "dsh",
  displayName: "DeepSeek Harness",
  docsUrl: "https://github.com/deepseek-ai/deepseek-harness",
  detect,
  isConfigured,
  configure,
  unconfigure,
  install,
  spawn,
};
