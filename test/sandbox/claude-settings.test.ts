import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeSettingsArgs,
  toolHookArgs,
} from "../../src/sandbox/tool-hooks.js";
const directories: string[] = [];
async function home() {
  const path = await mkdtemp(join(tmpdir(), "opper-claude-settings-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe("Claude under outer SRT", () => {
  it("disables only the nested sandbox, preserves permissions and combines hooks", async () => {
    const directory = await home();
    const existingHook = {
      matcher: "Bash",
      hooks: [{ type: "command", command: "echo existing" }],
    };
    const settings = {
      sandbox: { enabled: true, allowUnsandboxedCommands: false },
      permissions: { deny: ["Read(.env)"], defaultMode: "default" },
      hooks: { PreToolUse: [existingHook] },
      env: { SOME_SECRET: "test-secret" },
    };
    const args = await toolHookArgs(
      "claude",
      ["--settings", JSON.stringify(settings), "-p", "literal prompt"],
      directory,
      directory,
    );
    expect(args.filter((arg) => arg === "--settings")).toHaveLength(1);
    expect(args.slice(2)).toEqual(["-p", "literal prompt"]);
    expect(args.join(" ")).not.toContain("test-secret");
    const merged = JSON.parse(await readFile(args[1]!, "utf8"));
    expect(merged.sandbox).toEqual({
      enabled: false,
      allowUnsandboxedCommands: false,
    });
    expect(merged.permissions).toEqual(settings.permissions);
    expect(merged.env).toEqual(settings.env);
    expect(merged.hooks.PreToolUse.length).toBeGreaterThan(2);
    expect(merged.hooks.PreToolUse[0]).toEqual(existingHook);
    if (process.platform !== "win32")
      expect((await stat(args[1]!)).mode & 0o777).toBe(0o600);
  });
  it("reads a settings file without changing it and respects the argument terminator", async () => {
    const directory = await home();
    const file = join(directory, "original.json");
    const original = JSON.stringify({
      sandbox: { enabled: true },
      model: "original-model",
    });
    await writeFile(file, original);
    const args = await claudeSettingsArgs(
      [`--settings=${file}`, "--", "--settings", "literal"],
      {},
      directory,
    );
    expect(args.slice(2)).toEqual(["--", "--settings", "literal"]);
    expect(JSON.parse(await readFile(args[1]!, "utf8"))).toEqual({
      sandbox: { enabled: false },
      model: "original-model",
    });
    expect(await readFile(file, "utf8")).toBe(original);
  });
  it("coordinates Claude even without monitoring and leaves other agents alone", async () => {
    const directory = await home();
    const args = await toolHookArgs("claude", [], directory);
    expect(JSON.parse(await readFile(args[1]!, "utf8"))).toEqual({
      sandbox: { enabled: false },
    });
    expect(await toolHookArgs("codex", ["--version"], directory)).toEqual([
      "--version",
    ]);
  });
  it("fails closed for malformed settings without echoing their content", async () => {
    const directory = await home();
    await expect(
      claudeSettingsArgs(
        ["--settings", '{"secret":"do-not-print"'],
        {},
        directory,
      ),
    ).rejects.toThrow("Could not read Claude --settings as a JSON object");
    await expect(
      claudeSettingsArgs(["--settings"], {}, directory),
    ).rejects.toThrow("requires a JSON object or file");
  });
});
