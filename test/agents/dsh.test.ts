import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";

const whichMock = vi.fn();
const runMock = vi.fn();
vi.mock("../../src/util/which.js", () => ({ which: whichMock }));
vi.mock("../../src/util/run.js", () => ({ run: runMock }));

const { dsh } = await import("../../src/agents/dsh.js");

const SESSION_URL =
  "https://api.opper.ai/v3/session/sess_aa11bb22-cccc-4ddd-8eee-ffff00001111/customer:acme";

const SESSION_ID = "sess_aa11bb22-cccc-4ddd-8eee-ffff00001111";

const ROUTING = {
  baseUrl: SESSION_URL,
  sessionId: SESSION_ID,
  apiKey: "op_live_run",
  model: "claude-opus-5",
  compatShape: "openai" as const,
};

function settingsPath(sandbox: string): string {
  return join(sandbox, ".dsh", "settings.yaml");
}
function credentialsPath(sandbox: string): string {
  return join(sandbox, ".dsh", ".credentials.yaml");
}

interface Settings {
  "llm-pi-ai"?: {
    providers?: Record<
      string,
      {
        apiKeyEnv?: string;
        api?: string;
        baseURL?: string;
        compat?: Record<string, unknown>;
        headers?: Record<string, string>;
        models?: Array<{ id: string; contextWindow?: number }>;
      }
    >;
  };
  "agent-default-model"?: { provider?: string; model?: string };
  [k: string]: unknown;
}

function readCreds(sandbox: string): {
  version?: number;
  refs?: Record<string, string>;
  records?: Record<string, unknown>;
  [k: string]: unknown;
} {
  return parse(readFileSync(credentialsPath(sandbox), "utf8"));
}

function readSettings(sandbox: string): Settings {
  return parse(readFileSync(settingsPath(sandbox), "utf8")) as Settings;
}

describe("dsh adapter", () => {
  let sandbox: string;
  let prevHome: string | undefined;
  let prevDshHome: string | undefined;

  beforeEach(() => {
    whichMock.mockReset();
    runMock.mockReset();
    whichMock.mockResolvedValue("/usr/local/bin/dsh");
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === "--version") return { code: 0, stdout: "0.1.2-rc.1" };
      return { code: 0, stdout: "" };
    });
    sandbox = mkdtempSync(join(tmpdir(), "opper-dsh-"));
    prevHome = process.env.HOME;
    prevDshHome = process.env.DSH_HOME;
    process.env.HOME = sandbox;
    delete process.env.DSH_HOME;
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
  });

  it("metadata is correct", () => {
    expect(dsh.name).toBe("dsh");
    expect(dsh.displayName).toBe("DeepSeek Harness");
    expect(typeof dsh.spawn).toBe("function");
    expect(typeof dsh.install).toBe("function");
  });

  it("detect reports the parsed version and the settings path", async () => {
    const result = await dsh.detect();
    expect(result.installed).toBe(true);
    expect(result.version).toBe("0.1.2-rc.1");
    expect(result.configPath).toBe(settingsPath(sandbox));
  });

  it("detect reports not installed when dsh isn't on PATH", async () => {
    whichMock.mockResolvedValue(null);
    expect(await dsh.detect()).toEqual({ installed: false });
  });

  it("honours DSH_HOME over ~/.dsh", async () => {
    const home = join(sandbox, "custom-home");
    process.env.DSH_HOME = home;
    await dsh.configure({ apiKey: "op_live_test" });
    expect(existsSync(join(home, "settings.yaml"))).toBe(true);
    expect(existsSync(settingsPath(sandbox))).toBe(false);
  });

  it("configure (no apiKey) throws AUTH_REQUIRED", async () => {
    await expect(dsh.configure({})).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });

  it("configure writes the compat URL route and the default model", async () => {
    await dsh.configure({ apiKey: "op_live_test" });
    const settings = readSettings(sandbox);
    const route = settings["llm-pi-ai"]?.providers?.opper;
    expect(route?.baseURL).toBe("https://api.opper.ai/v3/compat");
    expect(route?.api).toBe("openai-completions");
    expect(route?.compat).toEqual({
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      cacheControlFormat: "anthropic",
    });
    expect(settings["agent-default-model"]).toEqual({
      provider: "opper",
      model: "claude-opus-5",
    });
  });

  it("configure never writes the literal key into settings — only the credential reference", async () => {
    await dsh.configure({ apiKey: "op_live_test" });
    const raw = readFileSync(settingsPath(sandbox), "utf8");
    expect(raw).not.toContain("op_live_test");
    expect(readSettings(sandbox)["llm-pi-ai"]?.providers?.opper?.apiKeyEnv).toBe(
      "OPPER_API_KEY",
    );
  });

  it("configure stores the key in .credentials.yaml in the versioned layout at mode 0600", async () => {
    await dsh.configure({ apiKey: "op_live_test" });
    // dsh reads `version: 1` with refs nested under `refs:`, and rejects any
    // unknown top-level key — a flat `OPPER_API_KEY:` at the root stops its boot.
    expect(readCreds(sandbox)).toEqual({
      version: 1,
      refs: { OPPER_API_KEY: "op_live_test" },
    });
    if (process.platform !== "win32") {
      expect(statSync(credentialsPath(sandbox)).mode & 0o777).toBe(0o600);
    }
  });

  it("configure migrates a pre-release flat credential file instead of mixing layouts", async () => {
    mkdirSync(join(sandbox, ".dsh"), { recursive: true });
    writeFileSync(
      credentialsPath(sandbox),
      "# their store\nDEEPSEEK_API_KEY: sk-theirs\n",
      { mode: 0o600 },
    );

    await dsh.configure({ apiKey: "op_live_test" });

    expect(readCreds(sandbox)).toEqual({
      version: 1,
      refs: { DEEPSEEK_API_KEY: "sk-theirs", OPPER_API_KEY: "op_live_test" },
    });
    expect(readFileSync(credentialsPath(sandbox), "utf8")).toContain("# their store");
  });

  it("configure keeps sign-in records and other refs in a versioned file", async () => {
    mkdirSync(join(sandbox, ".dsh"), { recursive: true });
    writeFileSync(
      credentialsPath(sandbox),
      "version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-theirs\nrecords:\n  llm-pi-ai/anthropic:\n    kind: api-key\n",
      { mode: 0o600 },
    );

    await dsh.configure({ apiKey: "op_live_test" });

    const creds = readCreds(sandbox);
    expect(creds.refs).toEqual({
      DEEPSEEK_API_KEY: "sk-theirs",
      OPPER_API_KEY: "op_live_test",
    });
    expect(creds.records).toEqual({ "llm-pi-ai/anthropic": { kind: "api-key" } });
  });

  it("configure refuses to clobber a credential store it cannot parse", async () => {
    mkdirSync(join(sandbox, ".dsh"), { recursive: true });
    writeFileSync(credentialsPath(sandbox), "refs:\n  A: [1,\n  B: :\n", { mode: 0o600 });

    await expect(dsh.configure({ apiKey: "op_live_test" })).rejects.toMatchObject({
      code: "AGENT_CONFIG_CONFLICT",
    });
    expect(readFileSync(credentialsPath(sandbox), "utf8")).toContain("A: [1,");
  });

  it("configure preserves other credentials and other settings sections", async () => {
    mkdirSync(join(sandbox, ".dsh"), { recursive: true });
    writeFileSync(credentialsPath(sandbox), "DEEPSEEK_API_KEY: sk-theirs\n", {
      mode: 0o600,
    });
    writeFileSync(
      settingsPath(sandbox),
      "# my settings\nllm-deepseek:\n  reasoningEffort: max\n",
      "utf8",
    );

    await dsh.configure({ apiKey: "op_live_test" });

    expect(readCreds(sandbox).refs).toEqual({
      DEEPSEEK_API_KEY: "sk-theirs",
      OPPER_API_KEY: "op_live_test",
    });
    const raw = readFileSync(settingsPath(sandbox), "utf8");
    expect(raw).toContain("# my settings");
    expect(raw).toContain("reasoningEffort: max");
  });

  it("configure refuses to clobber settings it cannot parse", async () => {
    mkdirSync(join(sandbox, ".dsh"), { recursive: true });
    const broken = "telemetry: false\nmcp-servers: [oops\ntheme: dark\n";
    writeFileSync(settingsPath(sandbox), broken, "utf8");

    await expect(dsh.configure({ apiKey: "op_live_test" })).rejects.toMatchObject({
      code: "AGENT_CONFIG_CONFLICT",
    });
    expect(readFileSync(settingsPath(sandbox), "utf8")).toBe(broken);
  });

  it("spawn refuses to clobber settings it cannot parse", async () => {
    mkdirSync(join(sandbox, ".dsh"), { recursive: true });
    const broken = "telemetry: false\nmcp-servers: [oops\n";
    writeFileSync(settingsPath(sandbox), broken, "utf8");

    await expect(dsh.spawn!([], ROUTING)).rejects.toMatchObject({
      code: "AGENT_CONFIG_CONFLICT",
    });
    expect(readFileSync(settingsPath(sandbox), "utf8")).toBe(broken);
  });

  it("isConfigured reflects the presence of our route", async () => {
    expect(await dsh.isConfigured()).toBe(false);
    await dsh.configure({ apiKey: "op_live_test" });
    expect(await dsh.isConfigured()).toBe(true);
  });

  it("spawn writes the session URL and pins the launch model mid-launch", async () => {
    let midRun: Settings | undefined;
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === "--version") return { code: 0, stdout: "0.1.2-rc.1" };
      midRun = readSettings(sandbox);
      return { code: 0, stdout: "" };
    });

    const code = await dsh.spawn!([], { ...ROUTING, model: "gpt-5.5" });
    expect(code).toBe(0);

    const route = midRun?.["llm-pi-ai"]?.providers?.opper;
    expect(route?.baseURL).toBe(SESSION_URL);
    expect(route?.apiKeyEnv).toBe("OPPER_API_KEY");
    expect(midRun?.["agent-default-model"]).toEqual({
      provider: "opper",
      model: "gpt-5.5",
    });
  });

  it("spawn marks the route for Anthropic-style prompt caching", async () => {
    let midRun: Settings | undefined;
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === "--version") return { code: 0, stdout: "" };
      midRun = readSettings(sandbox);
      return { code: 0, stdout: "" };
    });

    await dsh.spawn!([], ROUTING);

    // Without this, pi-ai addresses Opper as plain OpenAI and sends no cache
    // markers at all — every turn re-bills the whole prefix.
    expect(midRun?.["llm-pi-ai"]?.providers?.opper?.compat).toEqual({
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      cacheControlFormat: "anthropic",
    });
  });

  it("spawn pins the session to one provider with the affinity headers", async () => {
    let midRun: Settings | undefined;
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === "--version") return { code: 0, stdout: "" };
      midRun = readSettings(sandbox);
      return { code: 0, stdout: "" };
    });

    await dsh.spawn!([], ROUTING);

    // The uuid comes from the session in the base URL, and both headers carry
    // it: same provider for every turn (so a written cache is readable) and a
    // session root span for the trace.
    expect(midRun?.["llm-pi-ai"]?.providers?.opper?.headers).toEqual({
      "X-Opper-Trace-Id": "aa11bb22-cccc-4ddd-8eee-ffff00001111",
      "X-Opper-Parent-Span-Id": "aa11bb22-cccc-4ddd-8eee-ffff00001111",
      session_id: SESSION_ID,
      "x-client-request-id": SESSION_ID,
      "x-session-affinity": SESSION_ID,
    });
  });

  it("configure writes no affinity headers — the compat URL has no session to pin", async () => {
    await dsh.configure({ apiKey: "op_live_test" });
    expect(
      readSettings(sandbox)["llm-pi-ai"]?.providers?.opper?.headers,
    ).toBeUndefined();
  });

  it("spawn lists a non-curated --model id on the route so it isn't UNKNOWN_MODEL", async () => {
    let midRun: Settings | undefined;
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === "--version") return { code: 0, stdout: "" };
      midRun = readSettings(sandbox);
      return { code: 0, stdout: "" };
    });

    await dsh.spawn!([], { ...ROUTING, model: "deepinfra/some-new-model" });

    const ids = (midRun?.["llm-pi-ai"]?.providers?.opper?.models ?? []).map(
      (m) => m.id,
    );
    expect(ids).toContain("deepinfra/some-new-model");
    expect(ids).toContain("claude-opus-5");
  });

  it("spawn exports the session key in the child env, never on disk", async () => {
    let midRunRaw = "";
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === "--version") return { code: 0, stdout: "" };
      midRunRaw = readFileSync(settingsPath(sandbox), "utf8");
      return { code: 0, stdout: "" };
    });

    await dsh.spawn!([], ROUTING);

    const call = runMock.mock.calls.find(
      (c) => c[0] === "dsh" && c[1]?.[0] !== "--version",
    )!;
    expect(call[2].env.OPPER_API_KEY).toBe("op_live_run");
    expect(call[2].inherit).toBe(true);
    expect(midRunRaw).not.toContain("op_live_run");
    expect(existsSync(credentialsPath(sandbox))).toBe(false);
  });

  it("spawn defaults to `dsh web` when no args are passed", async () => {
    await dsh.spawn!([], ROUTING);
    const call = runMock.mock.calls.find(
      (c) => c[0] === "dsh" && c[1]?.[0] !== "--version",
    )!;
    expect(call[1]).toEqual(["web"]);
  });

  it("spawn forwards user-supplied args verbatim", async () => {
    await dsh.spawn!(["--profile", "headless", "run the tests"], ROUTING);
    const call = runMock.mock.calls.find(
      (c) => c[0] === "dsh" && c[1]?.[0] !== "--version",
    )!;
    expect(call[1]).toEqual(["--profile", "headless", "run the tests"]);
  });

  it("spawn restores the pre-launch settings so a direct `dsh` run doesn't inherit the session URL", async () => {
    await dsh.configure({ apiKey: "op_user_key" });
    const before = readFileSync(settingsPath(sandbox), "utf8");

    await dsh.spawn!([], ROUTING);

    expect(readFileSync(settingsPath(sandbox), "utf8")).toBe(before);
  });

  it("spawn deletes the settings file it created when none existed before", async () => {
    expect(existsSync(settingsPath(sandbox))).toBe(false);
    await dsh.spawn!([], ROUTING);
    expect(existsSync(settingsPath(sandbox))).toBe(false);
  });

  it("spawn restores the pre-launch settings even on non-zero exit", async () => {
    await dsh.configure({ apiKey: "op_user_key" });
    const before = readFileSync(settingsPath(sandbox), "utf8");

    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === "--version") return { code: 0, stdout: "" };
      return { code: 17, stdout: "" };
    });
    const code = await dsh.spawn!([], ROUTING);

    expect(code).toBe(17);
    expect(readFileSync(settingsPath(sandbox), "utf8")).toBe(before);
  });

  it("spawn restore keeps settings the harness itself wrote mid-session", async () => {
    await dsh.configure({ apiKey: "op_user_key" });

    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === "--version") return { code: 0, stdout: "" };
      // The web UI's Models page writes to the same document we do.
      const cur = parse(readFileSync(settingsPath(sandbox), "utf8")) as Settings;
      const providers = cur["llm-pi-ai"]?.providers ?? {};
      providers.mine = { baseURL: "https://gateway.example/v1" };
      cur["llm-pi-ai"] = { providers };
      cur.telemetry = false;
      writeFileSync(
        settingsPath(sandbox),
        stringify(cur),
        "utf8",
      );
      return { code: 0, stdout: "" };
    });

    await dsh.spawn!([], ROUTING);

    const after = readSettings(sandbox);
    expect(after["llm-pi-ai"]?.providers?.mine).toEqual({
      baseURL: "https://gateway.example/v1",
    });
    expect(after.telemetry).toBe(false);
    // Ours is back to the pre-launch compat URL, not the session URL.
    expect(after["llm-pi-ai"]?.providers?.opper?.baseURL).toBe(
      "https://api.opper.ai/v3/compat",
    );
  });

  it("spawn restore preserves the user's comments elsewhere in the file", async () => {
    mkdirSync(join(sandbox, ".dsh"), { recursive: true });
    writeFileSync(
      settingsPath(sandbox),
      "# hand-written\nllm-deepseek:\n  reasoningEffort: max # keep me\n",
      "utf8",
    );

    await dsh.spawn!([], ROUTING);

    const raw = readFileSync(settingsPath(sandbox), "utf8");
    expect(raw).toContain("# hand-written");
    expect(raw).toContain("# keep me");
    expect(raw).not.toContain(SESSION_URL);
  });

  it("spawn restores a pre-existing default model instead of leaving the launch one", async () => {
    mkdirSync(join(sandbox, ".dsh"), { recursive: true });
    writeFileSync(
      settingsPath(sandbox),
      "agent-default-model:\n  provider: deepseek\n  model: deepseek-v4-pro\n",
      "utf8",
    );

    await dsh.spawn!([], ROUTING);

    expect(readSettings(sandbox)["agent-default-model"]).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });
  });

  it("spawn propagates non-zero exit codes", async () => {
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args?.[0] === "--version") return { code: 0, stdout: "" };
      return { code: 2, stdout: "" };
    });
    expect(await dsh.spawn!([], ROUTING)).toBe(2);
  });

  it("unconfigure removes our route, our default model, and our credential", async () => {
    await dsh.configure({ apiKey: "op_live_test" });
    await dsh.unconfigure();

    const settings = readSettings(sandbox);
    expect(settings["llm-pi-ai"]).toBeUndefined();
    expect(settings["agent-default-model"]).toBeUndefined();
    expect(existsSync(credentialsPath(sandbox))).toBe(false);
  });

  it("unconfigure leaves a default model that points at another provider", async () => {
    await dsh.configure({ apiKey: "op_live_test" });
    const doc = parse(readFileSync(settingsPath(sandbox), "utf8")) as Settings;
    doc["agent-default-model"] = { provider: "deepseek", model: "deepseek-v4-pro" };
    writeFileSync(settingsPath(sandbox), stringify(doc), "utf8");

    await dsh.unconfigure();

    expect(readSettings(sandbox)["agent-default-model"]).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });
  });

  it("unconfigure leaves other providers and other credentials alone", async () => {
    await dsh.configure({ apiKey: "op_live_test" });
    writeFileSync(
      credentialsPath(sandbox),
      "version: 1\nrefs:\n  OPPER_API_KEY: op_live_test\n  DEEPSEEK_API_KEY: sk-theirs\n",
      { mode: 0o600 },
    );
    const doc = parse(readFileSync(settingsPath(sandbox), "utf8")) as Settings;
    doc["llm-pi-ai"]!.providers!.mine = { baseURL: "https://gateway.example/v1" };
    writeFileSync(settingsPath(sandbox), stringify(doc), "utf8");

    await dsh.unconfigure();

    const settings = readSettings(sandbox);
    expect(settings["llm-pi-ai"]?.providers?.opper).toBeUndefined();
    expect(settings["llm-pi-ai"]?.providers?.mine).toEqual({
      baseURL: "https://gateway.example/v1",
    });
    expect(readCreds(sandbox).refs).toEqual({ DEEPSEEK_API_KEY: "sk-theirs" });
  });

  it("unconfigure removes our key from a pre-release flat file without migrating it", async () => {
    mkdirSync(join(sandbox, ".dsh"), { recursive: true });
    writeFileSync(
      credentialsPath(sandbox),
      "OPPER_API_KEY: op_live_test\nDEEPSEEK_API_KEY: sk-theirs\n",
      { mode: 0o600 },
    );

    await dsh.unconfigure();

    expect(readCreds(sandbox)).toEqual({ DEEPSEEK_API_KEY: "sk-theirs" });
  });

  it("unconfigure leaves a credential store it cannot parse alone", async () => {
    mkdirSync(join(sandbox, ".dsh"), { recursive: true });
    writeFileSync(credentialsPath(sandbox), "refs:\n  A: [1,\n  B: :\n", { mode: 0o600 });

    await dsh.unconfigure();

    expect(readFileSync(credentialsPath(sandbox), "utf8")).toContain("A: [1,");
  });

  it("unconfigure is a no-op when nothing was configured", async () => {
    await expect(dsh.unconfigure()).resolves.toBeUndefined();
    expect(existsSync(settingsPath(sandbox))).toBe(false);
  });
});
