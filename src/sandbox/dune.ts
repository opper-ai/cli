import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import { which } from "../util/which.js";
import { startActivity } from "./activity.js";
import { checkSandbox, sandboxEnvironment } from "./launch.js";
import { runSrt } from "./srt.js";
import { toolHookArgs } from "./tool-hooks.js";

export const claudeDomains = [
  "api.anthropic.com",
  "claude.ai",
  "platform.claude.com",
  "console.anthropic.com",
];

export async function launchDune(
  args: string[],
  domains: string[] = [],
): Promise<number> {
  await checkSandbox("srt", "claude");
  const executable = await which("claude");
  if (!executable)
    throw new Error(
      "Claude Code is not installed. Install Claude Code before running dune claude.",
    );
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
  await mkdir(join(profileRoot, "claude"), { recursive: true, mode: 0o700 });
  const profile = await realpath(join(profileRoot, "claude"));
  if (!contains(profileRoot, profile))
    throw new Error("Dune's Claude profile must not point outside ~/.dune.");
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
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    activity = startActivity(project, events, token ?? "");
    activity.emit("HARNESS", "claude");
    activity.emit("MODEL", "Claude native selection");
    activity.emit("BACKEND", "srt");
    activity.emit("MONITOR", String(process.pid));
    activity.emit("SESSION", "dune / claude starting; project edits are live");
    activity.emit(
      "AUTH",
      "Claude native authentication; separate persistent Dune profile",
    );
    activity.emit(
      "COVERAGE",
      "Network: blocked proxy requests only; allowed traffic is not logged. Claude tool hooks are agent-reported.",
    );
    const allowedDomains = [...new Set([...claudeDomains, ...domains])];
    for (const domain of allowedDomains) activity.emit("ALLOW", domain);
    const env = sandboxEnvironment(home, temp);
    env.CLAUDE_CONFIG_DIR = profile;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    env.NODE_USE_ENV_PROXY = "1";
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
    const command = [
      executable,
      ...(await toolHookArgs("claude", args, home, events)),
    ];
    const literal = (path: string) => ({ path, literal: true as const });
    process.stderr.write(
      "Dune experimental sandbox · Claude native authentication\nProfile: " +
        profile +
        "\nProject edits are live. On first use, sign in with your Claude subscription. If the browser cannot open, copy Claude's login URL into your browser.\n",
    );
    const code = await runSrt(
      command,
      {
        allowPty: process.platform === "darwin" && Boolean(process.stdin.isTTY),
        network: { allowedDomains, deniedDomains: [] },
        filesystem: {
          allowWrite: [project, home, temp, events, profile].map(literal),
          denyRead: [
            ".ssh",
            ".aws",
            ".azure",
            ".kube",
            ".opper",
            ".claude",
            ".claude.json",
          ].map((name) => literal(join(hostHome, name))),
          denyWrite: [dirname(activity.path)].map(literal),
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
