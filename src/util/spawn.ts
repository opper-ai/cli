import { spawnSync as nativeSpawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";
import readCmdShim from "read-cmd-shim";

// Windows treats environment names case-insensitively. Match Node's sorted
// first-key behavior when a caller supplied both PATH and Path, for example.
function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).sort().find((key) => key.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

export function resolveWindowsCommand(command: string, options: SpawnSyncOptions = {}): string | undefined {
  const cwd = typeof options.cwd === "string" ? options.cwd : options.cwd ? fileURLToPath(options.cwd) : process.cwd();
  // A caller supplying a file path is intentionally choosing that file. Bare
  // commands, however, must only search PATH and never a checked-out project.
  if (isAbsolute(command) || /[\\/]/.test(command) || /^[a-z]:/i.test(command)) {
    const explicit = resolve(cwd, command);
    return existsSync(explicit) ? explicit : undefined;
  }
  if (!command || /[\r\n*?]/.test(command)) return undefined;
  const env = options.env ?? process.env;
  const lookupEnv = { ...env };
  const cwdIdentity = resolve(cwd).replace(/[\\/]+$/, "").toLowerCase();
  const path = (environmentValue(env, "PATH") ?? "").split(";").flatMap((entry) => {
    const directory = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!directory) return [];
    const absolute = resolve(cwd, directory);
    if (absolute.replace(/[\\/]+$/, "").toLowerCase() === cwdIdentity) return [];
    return [absolute];
  });
  if (!path.length) return undefined;
  for (const key of Object.keys(lookupEnv)) if (key.toUpperCase() === "PATH") delete lookupEnv[key];
  lookupEnv.PATH = path.join(";");
  const systemRoot = environmentValue(env, "SYSTEMROOT") ?? environmentValue(process.env, "SYSTEMROOT") ?? "C:\\Windows";
  if (!isAbsolute(systemRoot)) return undefined;
  const found = nativeSpawnSync(join(systemRoot, "System32", "where.exe"), [`$PATH:${command}`], {
    cwd,
    env: lookupEnv,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (found.error || found.status !== 0) return undefined;
  return found.stdout.split(/\r?\n/).find((line) => line.trim())?.trim();
}

function readFirstLine(target: string): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(target, "r");
    const firstBytes = Buffer.alloc(512);
    const length = readSync(descriptor, firstBytes, 0, firstBytes.length, 0);
    return firstBytes.toString("utf8", 0, length).split(/\r?\n/, 1)[0] ?? "";
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function nodeArguments(target: string): string[] | undefined {
  const firstLine = readFirstLine(target);
  if (firstLine === undefined) return undefined;
  if (!firstLine.startsWith("#!")) return /\.(?:cjs|mjs|js)$/i.test(target) ? [] : undefined;
  // npm's ordinary Node shebang, with simple interpreter flags if present.
  // More complex shell expressions must retain their original shim behavior.
  const node = firstLine.match(/^#!\s*(?:\S*[\\/]env\s+(?:-S\s+)?|\S*[\\/])?node(?:\.exe)?(?:\s+(.*))?$/);
  if (!node) return undefined;
  const flags = node[1]?.trim() ?? "";
  return /["'`$]/.test(flags) ? undefined : flags ? flags.split(/\s+/) : [];
}

function shimLaunch(shim: string): { command: string; args: string[] } | undefined {
  if (extname(shim) && !/\.cmd$/i.test(shim)) return undefined;
  try {
    // Node's own npm/npx wrappers compute their script through NPM_CLI_JS,
    // rather than the literal target used by ordinary cmd-shim wrappers.
    // Recognize only the known adjacent distribution files; never evaluate
    // wrapper source to discover or execute an arbitrary command.
    const distributed = basename(shim).toLowerCase().match(/^(npm|npx)(?:\.cmd)?$/);
    if (distributed) {
      const target = join(dirname(shim), "node_modules", "npm", "bin", `${distributed[1]}-cli.js`);
      const flags = nodeArguments(target);
      if (flags) {
        const adjacentNode = join(dirname(shim), "node.exe");
        return {
          command: existsSync(adjacentNode) ? adjacentNode : process.execPath,
          args: [...flags, target],
        };
      }
    }
    // read-cmd-shim's extension detection is case-sensitive; Windows paths are not.
    const target = resolve(dirname(shim), readCmdShim.sync(shim.toLowerCase()));
    if (/\.(?:exe|com)$/i.test(target)) return { command: target, args: [] };
    const flags = nodeArguments(target);
    if (!flags) return undefined;
    const adjacentNode = join(dirname(shim), "node.exe");
    const shimText = readFileSync(shim, "utf8");
    const usesAdjacentNode = /%(?:~dp0|dp0%)\\node\.exe/i.test(shimText);
    return {
      command: usesAdjacentNode && existsSync(adjacentNode) ? adjacentNode : process.execPath,
      args: [...flags, target],
    };
  } catch {
    return undefined;
  }
}

function spawnFailure(command: string, args: string[], code: "EINVAL" | "ENOENT", message: string): SpawnSyncReturns<Buffer | string> {
  const error = Object.assign(new Error(message), {
    code, errno: code === "EINVAL" ? -22 : -2, syscall: `spawnSync ${command}`, path: command, spawnargs: args,
  });
  return { pid: 0, output: [null, null, null], stdout: null, stderr: null, status: null, signal: null, error } as unknown as SpawnSyncReturns<Buffer | string>;
}

function windowsSpawnSync(
  command: string,
  argsOrOptions?: readonly string[] | SpawnSyncOptions,
  suppliedOptions?: SpawnSyncOptions,
): SpawnSyncReturns<Buffer | string> {
  const args = Array.isArray(argsOrOptions) ? [...argsOrOptions] : [];
  const options = (Array.isArray(argsOrOptions) ? suppliedOptions : argsOrOptions ?? suppliedOptions) as SpawnSyncOptions | undefined;
  const settings = options ?? {};
  // Explicit shell callers supply shell syntax intentionally. Native Node also
  // avoids cross-spawn incorrectly inventing ENOENT for an intentional exit 1.
  if (settings.shell === true || typeof settings.shell === "string") return nativeSpawnSync(command, args, settings);
  const executable = resolveWindowsCommand(command, settings);
  if (!executable) return spawnFailure(command, args, "ENOENT", `spawnSync ${command} ENOENT`);
  const shim = shimLaunch(executable);
  if (shim) return nativeSpawnSync(shim.command, [...shim.args, ...args], settings);
  if (/\.(?:exe|com)$/i.test(executable)) return nativeSpawnSync(executable, args, settings);
  // cmd.exe treats newlines as command boundaries even inside quoted arguments.
  // Only recognized npm Node shims can safely receive multiline prompts.
  if (args.some((arg) => /[\r\n]/.test(arg))) {
    return spawnFailure(command, args, "EINVAL", `Cannot safely pass multiline arguments to the Windows command ${command}.`);
  }
  // Resolve before the fallback too: cmd.exe and cross-spawn otherwise search
  // the current project before PATH, potentially executing an untrusted shim.
  // cross-spawn independently resolves a shebang interpreter using its own
  // CWD-first search. An unknown interpreter must not reopen that search.
  if (readFirstLine(executable)?.startsWith("#!")) {
    return spawnFailure(command, args, "EINVAL", `Cannot safely resolve the interpreter for the Windows command ${command}.`);
  }
  return crossSpawn.sync(executable, args, settings);
}

// Keep all native overloads and POSIX signal semantics. Recognized Windows npm
// shims are resolved to their program so user arguments never pass through cmd.
export const spawnSync: typeof nativeSpawnSync = process.platform === "win32"
  ? windowsSpawnSync as typeof nativeSpawnSync
  : nativeSpawnSync;
