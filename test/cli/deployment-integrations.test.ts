import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
describe("real CLI deployment integration setup", () => {
  let home: string;
  let configPath: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "opper-deployment-integrations-"));
    configPath = join(home, "editor", ".config", "opencode", "opencode.json");
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  function run(args: string[]) {
    const env = { ...process.env, OPPER_HOME: join(home, "auth"), OPPER_EDITOR_HOME: join(home, "editor"), NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
    for (const name of ["OPPER_API_KEY", "OPPER_BASE_URL", "OPPER_DEPLOYMENT"]) delete env[name];
    return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      const child = execFile(process.execPath, ["--import", "tsx", "src/index.ts", ...args], { cwd: root, env },
        (error, stdout, stderr) => done({ code: error ? typeof error.code === "number" ? error.code : 1 : 0, stdout, stderr }));
      child.stdin?.end();
    });
  }
  it("uses a global deployment flag for fresh MCP setup without runtime credentials", async () => {
    const result = await run(["mcp", "add", "opencode", "-d", "evroc"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ mcp: { opper: {
      type: "remote", url: "https://api.evroc.on.opper.ai/mcp", enabled: true,
    } } });
    expect(existsSync(join(home, "auth", "config.json"))).toBe(false);
    expect(result.stdout).toContain("choose permissions in Opper");
  }, 60_000);
  function seedProfiles() {
    mkdirSync(join(home, "auth"));
    writeFileSync(join(home, "auth", "config.json"), JSON.stringify({ version: 1, defaultKey: "default", keys: {
      default: { apiKey: "synthetic-main", baseUrl: "https://api.opper.ai" },
      work: { apiKey: "synthetic-evroc", baseUrl: "https://api.evroc.on.opper.ai" },
    } }));
  }
  it("defaults fresh unqualified setup to main/AWS", async () => {
    expect((await run(["mcp", "add", "opencode"])).code).toBe(0);
    expect(JSON.parse(readFileSync(configPath, "utf8")).mcp.opper.url).toBe("https://api.opper.ai/mcp");
  }, 60_000);
  it("remembers the selected Evroc profile, then preserves its connection on conflicting main setup", async () => {
    seedProfiles();
    expect((await run(["config", "use", "work"])).code).toBe(0);
    expect((await run(["editors", "opencode", "--mcp"])).code).toBe(0);
    const original = readFileSync(configPath, "utf8");
    expect(JSON.parse(original).mcp.opper.url).toBe("https://api.evroc.on.opper.ai/mcp");
    expect((await run(["-d", "evroc", "mcp", "add", "opencode"])).code).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(original);
    const conflict = await run(["-d", "main", "mcp", "add", "opencode"]);
    expect(conflict.code).not.toBe(0);
    expect(conflict.stderr).toContain("already uses different settings");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  }, 60_000);
});
