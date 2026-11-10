import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpperError } from "../errors.js";
import { shellQuote } from "./srt.js";

export async function toolHookArgs(
  agent: string,
  args: string[],
  home: string,
  events?: string,
): Promise<string[]> {
  if (agent !== "claude" && agent !== "pi") return args;
  if (!events)
    return agent === "claude" ? claudeSettingsArgs(args, {}, home) : args;
  const directory = join(home, ".opper-monitor");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const log = JSON.stringify(join(events, "tools.jsonl"));
  const writer = `import { appendFileSync } from 'node:fs';
const emit = (phase, tool, id = '') => { try { appendFileSync(${log}, JSON.stringify({phase, tool, id, time: Date.now()}) + '\\n'); } catch {} };\n`;
  if (agent === "pi") {
    const extension = join(directory, "activity.mjs");
    await writeFile(
      extension,
      writer +
        `export default function(pi) {
  pi.on('session_start', () => { emit('ready', 'pi'); });
  pi.on('tool_call', (e) => { emit('start', e.toolName, e.toolCallId); });
  pi.on('tool_result', (e) => { emit(e.isError ? 'error' : 'end', e.toolName, e.toolCallId); });
}\n`,
      { mode: 0o600 },
    );
    return ["--extension", extension, ...args];
  }
  const hook = join(directory, "claude.mjs");
  await writeFile(
    hook,
    writer +
      `let input = '';
for await (const chunk of process.stdin) { input += chunk; if (input.length > 1048576) process.exit(0); }
try {
  const e = JSON.parse(input);
  if (e.hook_event_name === 'SessionStart') emit('ready', 'claude');
  else emit(e.hook_event_name === 'PreToolUse' ? 'start' : e.hook_event_name === 'PostToolUseFailure' ? 'error' : 'end', e.tool_name, e.tool_use_id);
} catch {}
`,
    { mode: 0o600 },
  );
  const hooks = Object.fromEntries(
    ["SessionStart", "PreToolUse", "PostToolUse", "PostToolUseFailure"].map(
      (event) => [
        event,
        [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: `${shellQuote(process.execPath)} ${shellQuote(hook)}`,
                timeout: 5,
              },
            ],
          },
        ],
      ],
    ),
  );
  return claudeSettingsArgs(args, hooks, home);
}

// CLI settings apply only to this process. Managed Claude policy remains higher
// priority; the outer SRT boundary does not depend on Claude honoring this setting.
export async function claudeSettingsArgs(
  args: string[],
  hooks: Record<string, unknown[]>,
  home: string,
): Promise<string[]> {
  const forwarded: string[] = [];
  let source: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      forwarded.push(...args.slice(i));
      break;
    }
    if (arg === "--settings") {
      source = args[++i];
      if (!source || source.startsWith("--"))
        throw new OpperError(
          "INVALID_ARGUMENT",
          "Claude --settings requires a JSON object or file.",
        );
    } else if (arg.startsWith("--settings=")) {
      source = arg.slice("--settings=".length);
    } else forwarded.push(arg);
  }
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  let settings: Record<string, unknown> = {};
  if (source !== undefined) {
    try {
      const parsed: unknown = JSON.parse(
        source.trimStart().startsWith("{")
          ? source
          : await readFile(source, "utf8"),
      );
      if (!object(parsed)) throw new Error("object required");
      settings = parsed;
    } catch {
      throw new OpperError(
        "INVALID_ARGUMENT",
        "Could not read Claude --settings as a JSON object. Sandbox launch stopped.",
      );
    }
  }
  if (settings.sandbox !== undefined && !object(settings.sandbox))
    throw new OpperError(
      "INVALID_ARGUMENT",
      "Claude sandbox settings must be an object.",
    );
  if (settings.hooks !== undefined && !object(settings.hooks))
    throw new OpperError(
      "INVALID_ARGUMENT",
      "Claude hooks settings must be an object.",
    );
  const mergedHooks = {
    ...(settings.hooks as Record<string, unknown> | undefined),
  };
  for (const [event, entries] of Object.entries(hooks)) {
    const existing = mergedHooks[event];
    if (existing !== undefined && !Array.isArray(existing))
      throw new OpperError(
        "INVALID_ARGUMENT",
        "Claude hook entries must be arrays.",
      );
    mergedHooks[event] = [
      ...((existing as unknown[] | undefined) ?? []),
      ...entries,
    ];
  }
  const merged = {
    ...settings,
    sandbox: {
      ...(settings.sandbox as Record<string, unknown> | undefined),
      enabled: false,
    },
    ...(Object.keys(mergedHooks).length ? { hooks: mergedHooks } : {}),
  };
  const directory = join(home, ".opper-monitor");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "claude-settings.json");
  await writeFile(file, JSON.stringify(merged), { mode: 0o600 });
  return ["--settings", file, ...forwarded];
}
