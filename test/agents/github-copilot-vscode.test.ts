import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const whichMock = vi.fn();
vi.mock("../../src/util/which.js", () => ({ which: whichMock }));

const runMock = vi.fn();
vi.mock("../../src/util/run.js", () => ({ run: runMock }));

const confirmMock = vi.fn();
vi.mock("@clack/prompts", () => ({
  confirm: confirmMock,
  isCancel: (v: unknown) => typeof v === "symbol",
  log: { info: vi.fn(), success: vi.fn() },
}));

const { githubCopilotVSCode } = await import(
  "../../src/agents/github-copilot-vscode.js"
);
const { vscodeUserSettingsPath } = await import(
  "../../src/util/editor-paths.js"
);

/** Make `code --list-extensions` report the OAI extension as already
 * installed so configure() short-circuits the install prompt. */
function stubExtensionInstalled() {
  whichMock.mockResolvedValue("/usr/local/bin/code");
  runMock.mockReturnValue({
    code: 0,
    stdout: "johnny-zhao.oai-compatible-copilot\n",
    stderr: "",
  });
}

describe("github-copilot-vscode adapter", () => {
  let sandbox: string;
  let prevEditorHome: string | undefined;

  beforeEach(() => {
    whichMock.mockReset();
    runMock.mockReset();
    confirmMock.mockReset();
    sandbox = mkdtempSync(join(tmpdir(), "opper-ghcp-"));
    prevEditorHome = process.env.OPPER_EDITOR_HOME;
    process.env.OPPER_EDITOR_HOME = sandbox;
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    if (prevEditorHome === undefined) delete process.env.OPPER_EDITOR_HOME;
    else process.env.OPPER_EDITOR_HOME = prevEditorHome;
  });

  it("metadata is correct and adapter is configure-only (no spawn)", () => {
    expect(githubCopilotVSCode.name).toBe("github-copilot-vscode");
    expect(githubCopilotVSCode.displayName).toBe("GitHub Copilot (VS Code)");
    expect(githubCopilotVSCode.spawn).toBeUndefined();
    expect(typeof githubCopilotVSCode.install).toBe("function");
  });

  it("detect returns installed=false when `code` is not on PATH", async () => {
    whichMock.mockResolvedValue(null);
    const result = await githubCopilotVSCode.detect();
    expect(result.installed).toBe(false);
  });

  it("detect returns installed=true with the stable settings.json path", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/code");
    const result = await githubCopilotVSCode.detect();
    expect(result.installed).toBe(true);
    expect(result.configPath).toBe(vscodeUserSettingsPath("stable"));
  });

  it("isConfigured is false when settings.json is missing", async () => {
    expect(await githubCopilotVSCode.isConfigured()).toBe(false);
  });

  it("configure writes oaicopilot.baseUrl + oaicopilot.models with all picker entries", async () => {
    stubExtensionInstalled();
    const { PICKER_MODELS } = await import("../../src/config/models.js");
    await githubCopilotVSCode.configure({});
    const path = vscodeUserSettingsPath("stable");
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed["oaicopilot.baseUrl"]).toBe("https://api.opper.ai/v3/compat");
    const models = parsed["oaicopilot.models"] as Array<{ id: string }>;
    expect(models).toHaveLength(PICKER_MODELS.length);
    expect(models.map((m) => m.id)).toEqual(PICKER_MODELS.map((m) => m.id));
    expect(await githubCopilotVSCode.isConfigured()).toBe(true);
    // No prompt fired because the extension was already present.
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("configure preserves unrelated keys and other oaicopilot.* extension settings", async () => {
    stubExtensionInstalled();
    const path = vscodeUserSettingsPath("stable");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        {
          "workbench.colorTheme": "Dark Modern",
          "oaicopilot.delay": 250,
          "oaicopilot.commitLanguage": "English",
        },
        null,
        4,
      ),
      "utf8",
    );
    await githubCopilotVSCode.configure({});
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed["workbench.colorTheme"]).toBe("Dark Modern");
    expect(parsed["oaicopilot.delay"]).toBe(250);
    expect(parsed["oaicopilot.commitLanguage"]).toBe("English");
    expect(parsed["oaicopilot.baseUrl"]).toBe("https://api.opper.ai/v3/compat");
  });

  it("configure is idempotent — re-running produces identical output", async () => {
    stubExtensionInstalled();
    await githubCopilotVSCode.configure({});
    const first = readFileSync(vscodeUserSettingsPath("stable"), "utf8");
    await githubCopilotVSCode.configure({});
    const second = readFileSync(vscodeUserSettingsPath("stable"), "utf8");
    expect(second).toBe(first);
  });

  it("configure throws on JSONC files (// comments) so user comments aren't lost", async () => {
    stubExtensionInstalled();
    const path = vscodeUserSettingsPath("stable");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      ['{', '  // user comment', '  "workbench.colorTheme": "Dark Modern"', "}"].join(
        "\n",
      ),
      "utf8",
    );
    await expect(githubCopilotVSCode.configure({})).rejects.toThrow(
      /Could not parse/,
    );
  });

  it("configure prompts and installs when the extension is missing and user confirms", async () => {
    let listCalls = 0;
    whichMock.mockResolvedValue("/usr/local/bin/code");
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "--list-extensions") {
        listCalls += 1;
        // First check: not installed. Second check (after install): installed.
        return {
          code: 0,
          stdout: listCalls === 1 ? "" : "johnny-zhao.oai-compatible-copilot\n",
          stderr: "",
        };
      }
      // The actual `code --install-extension X` invocation
      return { code: 0, stdout: "", stderr: "" };
    });
    confirmMock.mockResolvedValue(true);

    await githubCopilotVSCode.configure({});

    expect(confirmMock).toHaveBeenCalledTimes(1);
    const installCall = runMock.mock.calls.find(
      (c) => c[1][0] === "--install-extension",
    );
    expect(installCall).toBeDefined();
    expect(installCall![1]).toEqual([
      "--install-extension",
      "johnny-zhao.oai-compatible-copilot",
    ]);
    expect(await githubCopilotVSCode.isConfigured()).toBe(true);
  });

  it("configure aborts cleanly when the user declines the install prompt", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/code");
    runMock.mockReturnValue({ code: 0, stdout: "", stderr: "" }); // empty extensions list
    confirmMock.mockResolvedValue(false);

    await expect(githubCopilotVSCode.configure({})).rejects.toMatchObject({
      code: "USER_CANCELLED",
    });
    // No install attempted, no settings written.
    const installCall = runMock.mock.calls.find(
      (c) => c[1][0] === "--install-extension",
    );
    expect(installCall).toBeUndefined();
    expect(existsSync(vscodeUserSettingsPath("stable"))).toBe(false);
  });

  it("unconfigure removes only the keys we own and leaves the rest", async () => {
    stubExtensionInstalled();
    const path = vscodeUserSettingsPath("stable");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        {
          "workbench.colorTheme": "Dark Modern",
          "oaicopilot.delay": 250,
        },
        null,
        4,
      ),
      "utf8",
    );
    await githubCopilotVSCode.configure({});
    await githubCopilotVSCode.unconfigure();
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed).not.toHaveProperty("oaicopilot.baseUrl");
    expect(parsed).not.toHaveProperty("oaicopilot.models");
    expect(parsed["workbench.colorTheme"]).toBe("Dark Modern");
    expect(parsed["oaicopilot.delay"]).toBe(250);
  });

  it("install runs `code --install-extension johnny-zhao.oai-compatible-copilot`", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/code");
    runMock.mockReturnValue({ code: 0, stdout: "", stderr: "" });
    await expect(githubCopilotVSCode.install!()).resolves.toBeUndefined();
    const [cmd, args] = runMock.mock.calls[0]!;
    expect(cmd).toBe("code");
    expect(args).toEqual([
      "--install-extension",
      "johnny-zhao.oai-compatible-copilot",
    ]);
  });

  it("install throws AGENT_NOT_FOUND when `code` exits non-zero", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/code");
    runMock.mockReturnValue({ code: 1, stdout: "", stderr: "boom" });
    await expect(githubCopilotVSCode.install!()).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  });

  it("install throws AGENT_NOT_FOUND when `code` is not on PATH", async () => {
    whichMock.mockResolvedValue(null);
    await expect(githubCopilotVSCode.install!()).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  });
});
