import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { which } from "../util/which.js";
import { startActivity } from "./activity.js";
import { checkSandbox, sandboxEnvironment } from "./launch.js";
import { runSrt } from "./srt.js";
import { readConfig } from "../auth/config.js";
import { opperHome } from "../auth/paths.js";
import type { DuneOptions } from "./dune-args.js";
import { toolHookArgs } from "./tool-hooks.js";

export const claudeDomains = [
  "api.anthropic.com",
  "claude.ai",
  "platform.claude.com",
  "console.anthropic.com",
];

export async function launchDune(
  commandArgs: string[],
  options: DuneOptions = { domains: [], env: [], write: [] },
): Promise<number> {
  await checkSandbox("srt", "claude");
  const [binary, ...args] = commandArgs;
  if (!binary) throw new Error("A command is required.");
  const harness = basename(binary);
  const nativeClaude = harness === "claude";
  const isOpper = harness === "opper";
  const executable = await which(binary);
  if (!executable) throw new Error(`Executable not found: ${binary}`);
  const project = await realpath(process.cwd());
  const hostHome = await realpath(homedir());
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return (
      !path ||
      (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
    );
  };
  const profileRoot = join(hostHome, ".dune");
  if (
    project === parse(project).root ||
    contains(project, hostHome) ||
    contains(profileRoot, project)
  )
    throw new Error(
      "Start dune from a project directory outside your home root and Dune profile.",
    );
  let profile: string | undefined;
  if (nativeClaude) {
    await mkdir(join(profileRoot, "claude"), { recursive: true, mode: 0o700 });
    profile = await realpath(join(profileRoot, "claude"));
    if (!contains(profileRoot, profile))
      throw new Error("Dune's Claude profile must not point outside ~/.dune.");
  }
  const extraWrites = await Promise.all(
    options.write.map((path) => realpath(resolve(path))),
  );
  for (const path of extraWrites) {
    if (!(await stat(path)).isDirectory())
      throw new Error("--allow-write requires an existing directory.");
    if (contains(path, hostHome) || path === parse(path).root)
      throw new Error(
        "--allow-write cannot grant the home directory or a filesystem root.",
      );
  }
  const config = isOpper ? await readConfig() : null;
  const opperDirectory = resolve(opperHome());
  const inherited: NodeJS.ProcessEnv = {};
  const names = [
    ...options.env,
    ...(isOpper ? ["OPPER_API_KEY", "OPPER_BASE_URL"] : []),
    ...(nativeClaude ? ["CLAUDE_CODE_OAUTH_TOKEN"] : []),
  ];
  for (const name of names) {
    if (
      [
        "HOME",
        "TMPDIR",
        "TMP",
        "TEMP",
        "CLAUDE_CONFIG_DIR",
        "OPPER_HOME",
      ].includes(name)
    )
      throw new Error(`Dune owns ${name}; it cannot be overridden with --env.`);
    if (process.env[name] !== undefined) inherited[name] = process.env[name];
  }
  const session = await realpath(
    await mkdtemp(join(tmpdir(), "dune-sandbox-")),
  );
  let activity: ReturnType<typeof startActivity> | undefined;
  try {
    const home = join(session, "home"),
      temp = join(session, "tmp"),
      events = join(session, "events");
    await mkdir(home);
    await mkdir(temp);
    activity = startActivity(project, events, [
      ...Object.values(inherited).filter((value): value is string => !!value),
      ...Object.values(config?.keys ?? {}).map((slot) => slot.apiKey),
    ]);
    activity.emit("HARNESS", harness);
    activity.emit(
      "MODEL",
      nativeClaude ? "Claude native selection" : "Selected by command",
    );
    activity.emit("BACKEND", "srt");
    activity.emit("MONITOR", String(process.pid));
    activity.emit(
      "SESSION",
      `dune / ${harness} starting; project edits are live`,
    );
    activity.emit(
      "AUTH",
      nativeClaude
        ? "Claude native authentication; separate persistent Dune profile"
        : isOpper
          ? "Existing Opper configuration is readable, not writable. Renew credentials outside Dune."
          : "Clean environment; only explicitly selected variables are passed.",
    );
    activity.emit(
      "COVERAGE",
      "Network: blocked proxy requests only; allowed traffic is not logged. Direct Claude/Pi commands have agent-reported tool hooks; other commands have no tool-call instrumentation.",
    );
    const defaults = nativeClaude
      ? claudeDomains
      : isOpper
        ? [
            new URL(inherited.OPPER_BASE_URL ?? "https://api.opper.ai")
              .hostname,
            ...Object.values(config?.keys ?? {}).map(
              (slot) =>
                new URL(slot.baseUrl ?? "https://api.opper.ai").hostname,
            ),
          ]
        : [];
    const allowedDomains = [...new Set([...defaults, ...options.domains])];
    for (const domain of allowedDomains) activity.emit("ALLOW", domain);
    const env = { ...sandboxEnvironment(home, temp), ...inherited };
    if (profile) env.CLAUDE_CONFIG_DIR = profile;
    if (nativeClaude) env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    if (isOpper) env.OPPER_HOME = opperDirectory;
    env.NODE_USE_ENV_PROXY = "1";
    const command = [
      executable,
      ...(await toolHookArgs(harness, args, home, events)),
    ];
    const literal = (path: string) => ({ path, literal: true as const });
    process.stderr.write(
      `Dune experimental sandbox · ${harness}\nProject edits are live. ${profile ? `Claude profile: ${profile}` : "Temporary home; network restricted to permitted hosts."}\n`,
    );
    const code = await runSrt(
      command,
      {
        allowPty: process.platform === "darwin" && Boolean(process.stdin.isTTY),
        network: { allowedDomains, deniedDomains: [] },
        filesystem: {
          allowWrite: [
            project,
            home,
            temp,
            events,
            ...extraWrites,
            ...(profile ? [profile] : []),
          ].map(literal),
          denyRead: [
            ".ssh",
            ".aws",
            ".azure",
            ".kube",
            ".claude",
            ".claude.json",
            ...(!nativeClaude ? [".dune"] : []),
            ...(!isOpper || opperDirectory !== join(hostHome, ".opper")
              ? [".opper"]
              : []),
          ]
            .map((name) => literal(join(hostHome, name)))
            .concat(isOpper ? [] : [literal(opperDirectory)]),
          denyWrite: [
            dirname(activity.path),
            ...(isOpper ? [opperDirectory] : []),
          ].map(literal),
        },
      },
      env,
      project,
      activity.emit,
    );
    activity.emit("EXIT", `agent exited ${code}`);
    return code;
  } catch (error) {
    activity?.emit("ERROR", "Dune launch failed; see terminal for details.");
    throw error;
  } finally {
    try {
      activity?.close();
    } finally {
      await rm(session, { recursive: true, force: true });
    }
  }
}
