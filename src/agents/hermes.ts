import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readFile, writeFile, rename, chmod, rm } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { which } from "../util/which.js";
import { run } from "../util/run.js";
import { takeSnapshot, restoreSnapshot, rotateBackups } from "../util/backup.js";
import { OpperError } from "../errors.js";
import type {
  AgentAdapter,
  DetectResult,
  OpperRouting,
} from "./types.js";

function hermesConfigPath(): string {
  return join(homedir(), ".hermes", "config.yaml");
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
  // Hermes has no persistent Opper bits to remove (launch does
  // snapshot → write → restore on every run).
}

async function writeRoutingToConfig(
  path: string,
  routing: OpperRouting,
): Promise<void> {
  const raw = await readFile(path, "utf8");
  const parsed = (parse(raw) as Record<string, unknown>) ?? {};
  // Hermes' provider field is a fixed enum (openrouter, anthropic, nous-portal,
  // …) — none of those are Opper. The "custom" provider drives an
  // OpenAI-shaped HTTP client at an arbitrary base_url, which is what we
  // need. Field names (`default` for the model id, not `model`) match what
  // Hermes' "Custom endpoint" wizard writes.
  parsed.model = {
    provider: "custom",
    base_url: routing.baseUrl,
    api_key: routing.apiKey,
    default: routing.model,
  };
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, stringify(parsed), "utf8");
  try {
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function spawn(args: string[], routing: OpperRouting): Promise<number> {
  const path = hermesConfigPath();
  if (!existsSync(path)) {
    throw new OpperError(
      "AGENT_CONFIG_CONFLICT",
      `Hermes config not found at ${path}`,
      "Run `hermes` once to initialise a config, then try again.",
    );
  }

  const handle = await takeSnapshot("hermes", path);
  await rotateBackups("hermes", 20);

  let spawnError: unknown;
  let exitCode: number;
  try {
    await writeRoutingToConfig(path, routing);
    const result = run("hermes", args, { inherit: true });
    exitCode = result.code;
  } catch (err) {
    spawnError = err;
    throw err;
  } finally {
    try {
      await restoreSnapshot(handle, path);
    } catch (restoreErr) {
      console.error(
        `\nFailed to restore Hermes config. Recover manually with:\n  cp "${handle.backupPath}" "${path}"`,
      );
      if (!spawnError) throw restoreErr;
    }
  }

  return exitCode!;
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
