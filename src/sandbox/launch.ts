import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { OpperError } from "../errors.js";
import { opperHome } from "../auth/paths.js";
import type { OpperRouting, SpawnOptions } from "../agents/types.js";

import { backends, type SandboxBackend } from "./catalog.js";
import { runSrt } from "./srt.js";
import { startActivity } from "./activity.js";
export type { SandboxBackend } from "./catalog.js";

export interface SandboxRequest {
  agent: string;
  args: string[];
  routing: OpperRouting;
  spawnOptions: SpawnOptions;
  activityDirectory?: string;
}

export async function checkSandbox(
  backend: string,
  agent: string,
  platform: string = process.platform,
): Promise<SandboxBackend> {
  if (!Object.hasOwn(backends, backend)) {
    throw new OpperError(
      "INVALID_ARGUMENT",
      `Unknown sandbox "${backend}". Choose ${Object.keys(backends).join(", ")}.`,
    );
  }
  const selected = backend as SandboxBackend;
  const spec = backends[selected];
  if (!spec.platforms.includes(platform)) {
    throw new OpperError(
      "INVALID_ARGUMENT",
      `${backend} is not supported on ${platform}.`,
      spec.hint,
    );
  }
  if (!["claude", "codex", "pi", "opencode", "hermes"].includes(agent)) {
    throw new OpperError(
      "INVALID_ARGUMENT",
      `Sandbox launch does not support ${agent}.`,
      "Use claude, codex, pi, opencode, or hermes. GUI and background services require a separate lifecycle.",
    );
  }
  await spec.load();
  return selected;
}

export function sandboxEnvironment(
  home: string,
  temp: string,
  source = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "TERM",
    "COLORTERM",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "NO_COLOR",
    "FORCE_COLOR",
  ]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return {
    ...env,
    HOME: home,
    TMPDIR: temp,
    // Claude uses /tmp on macOS unless its own temp override is set.
    CLAUDE_CODE_TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"),
    SHELL: "/bin/sh",
  };
}

export async function launchSandbox(
  backend: SandboxBackend,
  request: SandboxRequest,
  domains: string[] = [],
): Promise<number> {
  const project = await realpath(process.cwd());
  const hostHome = await realpath(homedir());
  const homeRelative = relative(project, hostHome);
  if (
    project === parse(project).root ||
    !homeRelative ||
    (!isAbsolute(homeRelative) &&
      homeRelative !== ".." &&
      !homeRelative.startsWith(`..${sep}`))
  ) {
    throw new OpperError(
      "INVALID_ARGUMENT",
      "Start a sandbox from a project directory, not your home or a directory containing it.",
    );
  }
  const session = await realpath(
    await mkdtemp(join(tmpdir(), "opper-sandbox-")),
  );
  const events = join(session, "events");
  let activity: ReturnType<typeof startActivity>;
  try {
    activity = startActivity(project, events, request.routing.apiKey);
  } catch (error) {
    await rm(session, { recursive: true, force: true });
    throw error;
  }
  activity.emit(
    "SESSION",
    `${backend} / ${request.agent} starting; project edits are live`,
  );
  activity.emit(
    "COVERAGE",
    "Network: blocked proxy requests only; allowed traffic is not logged.",
  );
  activity.emit(
    "COVERAGE",
    ["claude", "pi"].includes(request.agent)
      ? "Tool hooks configured; look for a hooks ready event. Agent options/settings can disable hooks."
      : "Tool events unavailable for this agent.",
  );
  if (request.agent === "claude")
    activity.emit(
      "POLICY",
      "Opper owns the outer SRT sandbox; requests Claude sandbox.enabled=false for this session. Managed settings may override it. Claude tool permissions are preserved.",
    );
  try {
    const home = join(session, "home");
    const temp = join(session, "tmp");
    await mkdir(home);
    await mkdir(temp);
    const requestPath = join(session, "request.json");
    await writeFile(
      requestPath,
      JSON.stringify({ ...request, activityDirectory: events }),
      { mode: 0o600 },
    );
    const worker = fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js",
        import.meta.url,
      ),
    );
    const command = [
      process.execPath,
      ...process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
      worker,
      requestPath,
    ];
    const env = sandboxEnvironment(home, temp);
    env.NODE_USE_ENV_PROXY = "1";
    process.stderr.write(
      "Experimental SRT library sandbox: temporary agent home; live project edits; network restricted to Opper and allowed hosts.\n",
    );
    const code = await runSrt(
      command,
      {
        network: {
          allowedDomains: [
            new URL(request.routing.baseUrl).hostname,
            ...domains,
          ],
          deniedDomains: [],
        },
        filesystem: {
          denyRead: [
            join(hostHome, ".ssh"),
            join(hostHome, ".aws"),
            join(hostHome, ".azure"),
            join(hostHome, ".kube"),
            resolve(opperHome()),
          ].map((path) => ({ path, literal: true })),
          allowWrite: [project, home, temp, events].map((path) => ({
            path,
            literal: true,
          })),
          denyWrite: [requestPath, dirname(activity.path)].map((path) => ({
            path,
            literal: true,
          })),
        },
      },
      env,
      project,
      activity.emit,
    );
    activity.emit("EXIT", `agent exited ${code}`);
    return code;
  } catch (error) {
    activity.emit(
      "ERROR",
      "Sandbox launch or execution failed; see terminal for details.",
    );
    throw error;
  } finally {
    try {
      activity.close();
    } finally {
      await rm(session, { recursive: true, force: true });
    }
  }
}
