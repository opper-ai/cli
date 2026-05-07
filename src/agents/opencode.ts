import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { which } from "../util/which.js";
import { npmInstallGlobal } from "./npm-install.js";
import { configureOpenCode } from "../setup/opencode.js";
import type {
  AgentAdapter,
  DetectResult,
  OpperRouting,
} from "./types.js";

function opencodeConfigPath(): string {
  return join(homedir(), ".config", "opencode", "opencode.json");
}

async function detect(): Promise<DetectResult> {
  const binaryPath = await which("opencode");
  if (!binaryPath) return { installed: false };
  const cfg = opencodeConfigPath();
  return {
    installed: true,
    ...(existsSync(cfg) ? { configPath: cfg } : {}),
  };
}

async function install(): Promise<void> {
  await npmInstallGlobal("opencode-ai", "https://opencode.ai");
}

async function isConfigured(): Promise<boolean> {
  const cfg = opencodeConfigPath();
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
  const cfg = opencodeConfigPath();
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

async function spawn(args: string[], routing: OpperRouting): Promise<number> {
  // Ensure the Opper provider block exists in the user's opencode config
  // (first-launch ergonomics). No-op if it's already there.
  await configureOpenCode({ location: "global" });

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
  install,
  spawn,
};
