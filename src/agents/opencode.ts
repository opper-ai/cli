import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { which } from "../util/which.js";
import {
  configureOpenCode,
  readProjectConfigState,
} from "../setup/opencode.js";
import { opencodeConfigPath } from "../util/editor-paths.js";
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
  await configureOpenCode({ location: "global" });
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

async function spawn(
  args: string[],
  routing: OpperRouting,
  opts: SpawnOptions = {},
): Promise<number> {
  const scope = opts.configScope ?? "user";

  if (scope === "project") {
    // Explicit opt-in to writing the cwd-local config. We never silently
    // mutate a project config the user didn't ask us to touch — that file
    // is usually checked in.
    await configureOpenCode({ location: "local" });
  } else {
    await configureOpenCode({ location: "global" });

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
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPPER_API_KEY: routing.apiKey,
  };
  const result = spawnSync("opencode", args, { stdio: "inherit", env });
  return result.status ?? -1;
}

export const opencode: AgentAdapter = {
  name: "opencode",
  displayName: "OpenCode",
  docsUrl: "https://opencode.ai",
  detect,
  isConfigured,
  configure,
  unconfigure,
  spawn,
};
