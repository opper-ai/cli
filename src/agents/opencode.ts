import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { which } from "../util/which.js";
import { npmInstallGlobal } from "./npm-install.js";
import {
  configureOpenCode,
  readProjectConfigState,
} from "../setup/opencode.js";
import { OPPER_COMPAT_URL } from "../config/endpoints.js";
import { opencodeConfigPath } from "../util/editor-paths.js";
import { withJsonKey } from "../util/config-snapshot.js";
import { brand } from "../ui/colors.js";
import type {
  AgentAdapter,
  DetectResult,
  OpperRouting,
  SpawnOptions,
} from "./types.js";

async function detect(): Promise<DetectResult> {
  const binaryPath = await which("opencode");
  if (!binaryPath) return { installed: false };
  const cfg = opencodeConfigPath("global");
  return {
    installed: true,
    ...(existsSync(cfg) ? { configPath: cfg } : {}),
  };
}

async function install(): Promise<void> {
  await npmInstallGlobal("opencode-ai", "https://opencode.ai");
}

async function isConfigured(): Promise<boolean> {
  const cfg = opencodeConfigPath("global");
  if (!existsSync(cfg)) return false;
  try {
    const parsed = JSON.parse(readFileSync(cfg, "utf8")) as {
      provider?: { opper?: unknown };
    };
    return parsed.provider?.opper !== undefined;
  } catch {
    return false;
  }
}

async function configure(): Promise<void> {
  // overwrite: true so a re-run pulls in the latest template (model list,
  // costs, defaults). Without it, an existing `provider.opper` block from
  // an older CLI version would be left in place and the new models would
  // never appear in OpenCode's picker.
  await configureOpenCode({ location: "global", overwrite: true });
}

async function unconfigure(): Promise<void> {
  const cfg = opencodeConfigPath("global");
  if (!existsSync(cfg)) return;
  let parsed: { provider?: Record<string, unknown>; [k: string]: unknown };
  try {
    parsed = JSON.parse(readFileSync(cfg, "utf8"));
  } catch {
    return;
  }
  if (!parsed.provider || parsed.provider.opper === undefined) return;

  const { opper: _opper, ...restProviders } = parsed.provider;
  void _opper;
  if (Object.keys(restProviders).length === 0) {
    delete parsed.provider;
  } else {
    parsed.provider = restProviders;
  }
  await writeFile(cfg, JSON.stringify(parsed, null, 2), "utf8");
}

/**
 * Rewrite `provider.opper.options.baseURL` in the existing opencode.json to
 * the per-launch URL (typically a /v3/session/<sid>/<tags...> URL). The
 * template only writes once via `configureOpenCode`, so without this step
 * launching a session would fall back to the default compat URL baked into
 * the template.
 */
async function setSessionBaseUrl(
  baseUrl: string,
  location: "global" | "local",
): Promise<void> {
  const cfg = opencodeConfigPath(location);
  if (!existsSync(cfg)) return;
  let parsed: {
    provider?: Record<string, { options?: Record<string, unknown> }>;
    [k: string]: unknown;
  };
  try {
    parsed = JSON.parse(readFileSync(cfg, "utf8"));
  } catch {
    return;
  }
  const opper = parsed.provider?.opper;
  if (!opper) return;
  opper.options = opper.options ?? {};
  opper.options.baseURL = baseUrl;
  await writeFile(cfg, JSON.stringify(parsed, null, 2), "utf8");
}

/**
 * Read `provider.opper.options.baseURL` from an opencode config without
 * mutating the file. Returns undefined when the file or the provider is
 * absent, or when the JSON is malformed — callers fall back to a default.
 */
function readBaseUrl(location: "global" | "local"): string | undefined {
  const cfg = opencodeConfigPath(location);
  if (!existsSync(cfg)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(cfg, "utf8")) as {
      provider?: { opper?: { options?: { baseURL?: unknown } } };
    };
    const url = parsed.provider?.opper?.options?.baseURL;
    return typeof url === "string" ? url : undefined;
  } catch {
    return undefined;
  }
}

async function spawn(
  args: string[],
  routing: OpperRouting,
  opts: SpawnOptions = {},
): Promise<number> {
  const scope = opts.configScope ?? "user";

  if (scope === "project") {
    // `--project` is opt-in to a persistent, usually-checked-in project
    // config. Reverting the whole opper provider on exit would defeat
    // the point — instead we apply the session URL only for the spawn
    // and reset baseURL afterwards. The opper provider block stays in
    // place across launches.
    await configureOpenCode({ location: "local", overwrite: true });
    // Capture *after* configureOpenCode so a fresh project picks up the
    // template's compat URL, while a hand-edited config (e.g. pointing
    // at a self-hosted Opper) keeps that custom URL across launches.
    const restoreUrl = readBaseUrl("local") ?? OPPER_COMPAT_URL;
    await setSessionBaseUrl(routing.baseUrl, "local");
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        OPPER_API_KEY: routing.apiKey,
      };
      const result = spawnSync("opencode", args, { stdio: "inherit", env });
      return result.status ?? -1;
    } finally {
      await setSessionBaseUrl(restoreUrl, "local");
    }
  }

  // User-scope: snapshot just `provider.opper` so direct `opencode`
  // invocations after the launch don't inherit this session's URL,
  // and so a launch on a machine with no prior opencode.json doesn't
  // leave one behind. OpenCode mutates this file during a session
  // (theme, default model, MCP servers, …) — narrow restore keeps
  // those edits and reverts only what we wrote.
  return withJsonKey(opencodeConfigPath("global"), ["provider", "opper"], async () => {
    await configureOpenCode({ location: "global", overwrite: true });

    // OpenCode reads `./opencode.json` if present and uses it instead of
    // the user-level config. If one exists without an Opper provider,
    // whatever we just wrote globally is dead weight — warn so the user
    // can re-run with `--project`.
    const projectPath = opencodeConfigPath("local");
    const state = readProjectConfigState(projectPath);
    if (state.exists && !state.hasOpperProvider) {
      process.stderr.write(
        brand.dim(
          `note: ${projectPath} will shadow the user-level Opper config. Re-run with \`--project\` to write the Opper provider there instead.\n`,
        ),
      );
    }

    await setSessionBaseUrl(routing.baseUrl, "global");

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPPER_API_KEY: routing.apiKey,
    };
    const result = spawnSync("opencode", args, { stdio: "inherit", env });
    return result.status ?? -1;
  });
}

export const opencode: AgentAdapter = {
  name: "opencode",
  displayName: "OpenCode",
  docsUrl: "https://opencode.ai",
  detect,
  isConfigured,
  configure,
  unconfigure,
  install,
  spawn,
};
