import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("commands independent of stored credentials", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "opper-independent-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function run(args: string[], overrides: Record<string, string> = {}) {
    const env: NodeJS.ProcessEnv = { ...process.env, OPPER_HOME: home,
      OPPER_EDITOR_HOME: home, OPPER_SKILLS_HOME: join(home, "skills"),
      CODEX_HOME: join(home, ".codex"), HERMES_HOME: join(home, ".hermes"),
      NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
    for (const name of ["OPPER_API_KEY", "OPPER_BASE_URL", "OPPER_DEPLOYMENT"]) delete env[name];
    Object.assign(env, overrides);
    return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      const child = execFile(process.execPath, ["--import", "tsx", "src/index.ts", ...args],
        { cwd: ROOT, env, timeout: 30_000 },
        (error, stdout, stderr) => done({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0, stdout, stderr }));
      child.stdin?.end();
    });
  }

  it.each(["malformed", "inaccessible"])("uses an independent environment key with %s stored configuration", async (kind) => {
    let configHome = home;
    if (kind === "malformed") writeFileSync(join(home, "config.json"), "{broken JSON");
    else { configHome = join(home, "not-a-directory"); writeFileSync(configHome, "blocked"); }
    const result = await run(["whoami"], { OPPER_HOME: configHome, OPPER_API_KEY: "synthetic-environment-credential", OPPER_DEPLOYMENT: "evroc" });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("OPPER_API_KEY");
    expect(result.stdout).toContain("https://api.evroc.on.opper.ai");
    expect(result.stdout).not.toContain("synthetic-environment-credential");
  }, 60_000);

  it.each([[["version"]], [["--help"]], [[]]])("prints %j without parsing malformed stored configuration", async (args) => {
    writeFileSync(join(home, "config.json"), "{broken JSON");
    const result = await run(args);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(args[0] === "version" ? /^\d+\.\d+\.\d+\n$/ : /Usage: opper/);
  }, 60_000);

  it("logout with an environment key still removes only the named deployment's saved slot", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, defaultKey: "main", keys: {
      main: { apiKey: "synthetic-main", baseUrl: "https://api.opper.ai" },
      evroc: { apiKey: "synthetic-evroc", baseUrl: "https://api.evroc.on.opper.ai" },
    } }));
    const result = await run(["-d", "evroc", "logout"], { OPPER_API_KEY: "synthetic-independent-environment-key" });
    expect(result.code, result.stderr).toBe(0);
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(config.keys.evroc).toBeUndefined();
    expect(config.keys.main.apiKey).toBe("synthetic-main");
    expect(config.defaultKey).toBe("main");
  }, 60_000);

  it("keeps matching credentials for runtime commands when no environment key is supplied", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, defaultKey: "main", keys: {
      main: { apiKey: "synthetic-main" },
      one: { apiKey: "synthetic-one", baseUrl: "https://api.evroc.on.opper.ai" },
      two: { apiKey: "synthetic-two", baseUrl: "https://api.evroc.on.opper.ai" },
    } }));
    const result = await run(["whoami"], { OPPER_DEPLOYMENT: "evroc" });
    expect(result.code).toBe(8);
    expect(result.stderr).toContain("Several slots");
  }, 60_000);

  it.each([[["skills", "list"]], [["agents", "list"]], [["editors", "list"]], [["version"]]])("runs %j without resolving ambiguous deployment credentials", async (args) => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, defaultKey: "default", keys: {
      default: { apiKey: "synthetic-main" },
      one: { apiKey: "synthetic-one", baseUrl: "https://api.evroc.on.opper.ai" },
      two: { apiKey: "synthetic-two", baseUrl: "https://api.evroc.on.opper.ai" },
    } }));
    const result = await run(args, { OPPER_DEPLOYMENT: "evroc" });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).not.toBe("");
  }, 60_000);
});
