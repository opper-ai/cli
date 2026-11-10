import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { startActivity } from "../../src/sandbox/activity.js";
import { toolHookArgs } from "../../src/sandbox/tool-hooks.js";
const directories: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "opper-monitor-test-"));
  directories.push(dir);
  return dir;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("sandbox activity", () => {
  it("keeps a private log, redacts credentials and terminal controls, and drains only tool metadata", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const project = temp();
    const events = temp();
    const monitor = startActivity(project, events, "test-secret");
    directories.push(dirname(monitor.path));
    try {
      monitor.emit("NETWORK", "test-secret\x1b[2J\nforged");
      appendFileSync(
        join(events, "tools.jsonl"),
        JSON.stringify({
          phase: "start",
          time: 1000,
          tool: "Bash",
          id: "one",
          input: "private-command",
          apiKey: "another-secret",
        }) + "\n",
      );
      appendFileSync(
        join(events, "tools.jsonl"),
        JSON.stringify({
          phase: "end",
          time: 1011,
          tool: "Bash",
          id: "one",
          output: "private-output",
        }) + "\n",
      );
      writeFileSync(join(project, "changed.txt"), "private-content");
      await vi.waitFor(
        () => {
          const output = readFileSync(monitor.path, "utf8");
          // macOS can initialize FSEvents after watch() returns.
          if (!output.includes("changed.txt"))
            writeFileSync(join(project, "changed.txt"), String(Date.now()));
          expect(output).toContain("changed.txt");
        },
        { timeout: 5000 },
      );
    } finally {
      monitor.close();
    }
    const output = readFileSync(monitor.path, "utf8");
    expect(output).toContain("Bash start");
    expect(output).toContain("Bash end");
    expect(output).toContain("[redacted]");
    for (const secret of [
      "test-secret",
      "private-command",
      "private-output",
      "private-content",
      "another-secret",
      "\x1b",
    ])
      expect(output).not.toContain(secret);
    expect(statSync(monitor.path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(monitor.path)).mode & 0o777).toBe(0o700);
    monitor.close();
  });

  it("runs Claude hooks without saving tool inputs or responses", async () => {
    const home = temp();
    const events = temp();
    const args = await toolHookArgs("claude", ["-p", "hello"], home, events);
    expect(args.slice(-2)).toEqual(["-p", "hello"]);
    const settings = JSON.parse(readFileSync(args[1]!, "utf8"));
    for (const name of [
      "SessionStart",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
    ]) {
      execFileSync(
        "/bin/sh",
        ["-c", settings.hooks[name][0].hooks[0].command],
        {
          input: JSON.stringify({
            hook_event_name: name,
            tool_name: "Bash",
            tool_use_id: "one",
            tool_input: { command: "secret" },
            tool_response: "secret",
          }),
        },
      );
    }
    const data = readFileSync(join(events, "tools.jsonl"), "utf8");
    expect(data).not.toContain("secret");
    expect(
      data
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).phase),
    ).toEqual(["ready", "start", "end", "error"]);
  });

  it("registers Pi tool callbacks and reports failure without modifying results", async () => {
    const home = temp();
    const events = temp();
    const args = await toolHookArgs("pi", [], home, events);
    const callbacks: Record<string, (event: any) => unknown> = {};
    const extension = await import(pathToFileURL(args[1]!).href);
    extension.default({
      on: (name: string, callback: any) => {
        callbacks[name] = callback;
      },
    });
    callbacks.session_start!({});
    expect(
      callbacks.tool_call!({
        toolName: "bash",
        toolCallId: "one",
        input: "secret",
      }),
    ).toBeUndefined();
    expect(
      callbacks.tool_result!({
        toolName: "bash",
        toolCallId: "one",
        isError: true,
        content: "secret",
      }),
    ).toBeUndefined();
    const data = readFileSync(join(events, "tools.jsonl"), "utf8");
    expect(data).not.toContain("secret");
    expect(
      data
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).phase),
    ).toEqual(["ready", "start", "error"]);
  });
});
