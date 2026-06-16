import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parse, stringify } from "yaml";
import { which } from "../util/which.js";
import { run } from "../util/run.js";
import { takeSnapshot, restoreSnapshot, rotateBackups } from "../util/backup.js";
import { OpperError } from "../errors.js";
import { PICKER_MODELS } from "../config/models.js";
import { assetPath } from "../util/assets.js";
import type { SnapshotHandle } from "../util/backup.js";
import type {
  AgentAdapter,
  DetectResult,
  OpperRouting,
} from "./types.js";

/**
 * The user's real Hermes home. We run `opper launch hermes` against it — not an
 * isolated dir — so the user's own skills, toolsets, agent preferences, and
 * other providers all load. The Opper bits (the `opper` model/provider block and
 * the provider plugin) are added transiently and restored on exit, so a launch
 * leaves the user's config exactly as it was.
 */
function hermesHome(): string {
  return process.env.HERMES_HOME ?? join(homedir(), ".hermes");
}

function hermesConfigPath(): string {
  return join(hermesHome(), "config.yaml");
}

function opperPluginDir(home: string): string {
  return join(home, "plugins", "model-providers", "opper");
}

async function detect(): Promise<DetectResult> {
  const path = await which("hermes");
  if (!path) return { installed: false };

  const versionResult = run("hermes", ["--version"]);
  // Pull a semver-shaped token from stdout. Avoids false positives from
  // help text like "hermes vupdate available".
  const versionMatch = versionResult.code === 0
    ? versionResult.stdout.match(/v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/)
    : null;
  const parsed = versionMatch ? versionMatch[1] : undefined;

  return {
    installed: true,
    ...(parsed ? { version: parsed } : {}),
    configPath: hermesConfigPath(),
  };
}

async function install(): Promise<void> {
  const result = run(
    "bash",
    ["-c", "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash"],
    { inherit: true },
  );
  if (result.code !== 0) {
    throw new OpperError(
      "AGENT_NOT_FOUND",
      `Hermes installer exited with code ${result.code}`,
      "Check your network connection and try again, or follow the manual install steps at https://hermes-agent.nousresearch.com/docs/",
    );
  }
}

async function isConfigured(): Promise<boolean> {
  return (await detect()).installed;
}

async function configure(): Promise<void> {
  if (!(await detect()).installed) {
    throw new OpperError(
      "AGENT_NOT_FOUND",
      "Hermes is not installed",
      "Run `opper launch hermes --install`, or install manually from https://hermes-agent.nousresearch.com/docs/.",
    );
  }
}

async function unconfigure(): Promise<void> {
  // Launch does snapshot → write → restore, so there's normally nothing to undo.
  // Drop the provider plugin defensively in case a previous launch was killed
  // before its restore ran.
  await rm(opperPluginDir(hermesHome()), { recursive: true, force: true });
}

/**
 * Write the Opper `model` + `providers.opper` blocks into the user's real
 * config.yaml, preserving every other key. Restored on exit by the spawn
 * snapshot.
 */
async function writeOpperConfig(routing: OpperRouting): Promise<void> {
  const path = hermesConfigPath();
  const existing: Record<string, unknown> = existsSync(path)
    ? ((parse(await readFile(path, "utf8")) as Record<string, unknown>) ?? {})
    : {};
  existing.model = {
    provider: "opper",
    base_url: routing.baseUrl,
    default: routing.model,
  };

  // `model.provider` and the providers entry must share the same key — Hermes
  // resolves the request-time api key from the ACTIVE provider's `key_env`. The
  // shipped `opper` plugin registers a matching profile and emits the
  // session/affinity headers. `key_env: OPPER_API_KEY` matches the env we export
  // at spawn, so no api key lands on disk; the dedicated name avoids clobbering
  // the user's real OPENAI_API_KEY. The curated `models:` dict is the fallback
  // when live discovery from `<base_url>/v1/models` fails.
  const opperModels: Record<string, Record<string, never>> = {};
  for (const m of PICKER_MODELS) opperModels[m.id] = {};
  const providers = (existing.providers as Record<string, unknown> | undefined) ?? {};
  providers.opper = {
    name: "Opper",
    base_url: routing.baseUrl,
    key_env: "OPPER_API_KEY",
    models: opperModels,
  };
  existing.providers = providers;

  await writeFile(path, stringify(existing), { mode: 0o600 });
}

/**
 * Ship the Opper provider plugin into the real Hermes home so Hermes loads it,
 * and return a restore fn. The plugin registers the `opper` provider and emits
 * the per-session `X-Opper-Trace-Id` / `X-Opper-Parent-Span-Id` headers that
 * drive provider affinity and the session-root span tree. Any pre-existing files
 * are captured and put back; a dir we created is removed — so a one-off launch
 * leaves the user's plugins untouched.
 */
async function installPlugin(home: string): Promise<() => Promise<void>> {
  const dir = opperPluginDir(home);
  const files = ["__init__.py", "plugin.yaml"];
  const dirExisted = existsSync(dir);
  const prior: Record<string, string | null> = {};
  for (const f of files) {
    const p = join(dir, f);
    prior[f] = existsSync(p) ? await readFile(p, "utf8") : null;
  }

  await mkdir(dir, { recursive: true });
  for (const f of files) {
    const contents = await readFile(assetPath(join("hermes-opper-plugin", f)), "utf8");
    await writeFile(join(dir, f), contents, { mode: 0o644 });
  }

  return async () => {
    try {
      if (!dirExisted) {
        await rm(dir, { recursive: true, force: true });
        // Best-effort: drop now-empty parents we may have created.
        await rm(join(home, "plugins", "model-providers"), { recursive: false, force: true }).catch(() => {});
        await rm(join(home, "plugins"), { recursive: false, force: true }).catch(() => {});
      } else {
        for (const f of files) {
          const p = join(dir, f);
          if (prior[f] !== null) await writeFile(p, prior[f]!, { mode: 0o644 });
          else await rm(p, { force: true });
        }
      }
    } catch (err) {
      process.stderr.write(
        `opper: failed to restore Hermes plugin after launch: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  };
}

async function spawn(args: string[], routing: OpperRouting): Promise<number> {
  const home = hermesHome();
  const path = hermesConfigPath();
  await mkdir(home, { recursive: true });

  // Snapshot the real config.yaml (whole-file backup) so the user's settings
  // come back exactly; if there was none, we delete the one we write.
  const configExisted = existsSync(path);
  let snapshot: SnapshotHandle | undefined;
  if (configExisted) {
    snapshot = await takeSnapshot("hermes", path);
    await rotateBackups("hermes", 20);
  }
  const restorePlugin = await installPlugin(home);

  try {
    await writeOpperConfig(routing);
    const result = run("hermes", args, {
      inherit: true,
      env: {
        ...process.env,
        HERMES_HOME: home,
        OPPER_API_KEY: routing.apiKey,
      },
    });
    return result.code;
  } finally {
    try {
      if (configExisted && snapshot) await restoreSnapshot(snapshot, path);
      else await rm(path, { force: true });
    } catch (err) {
      process.stderr.write(
        `opper: failed to restore ${path} after launch${
          snapshot ? ` — recover with: cp "${snapshot.backupPath}" "${path}"` : ""
        }: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    await restorePlugin();
  }
}

export const hermes: AgentAdapter = {
  name: "hermes",
  displayName: "Hermes Agent",
  docsUrl: "https://hermes-agent.nousresearch.com/docs/",
  detect,
  isConfigured,
  configure,
  unconfigure,
  install,
  spawn,
};
