import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
describe("real CLI deployment workflow", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "opper-deployment-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  function seed() {
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, defaultKey: "default", keys: {
      default: { apiKey: "synthetic-main", baseUrl: "https://api.opper.ai", user: { email: "main@example.invalid", name: "Main" } },
      work: { apiKey: "synthetic-evroc", baseUrl: "https://api.evroc.on.opper.ai", user: { email: "evroc@example.invalid", name: "Evroc" } },
    } }));
  }
  function run(args: string[], extra: Record<string, string> = {}, bootstrap?: string) {
    const env = { ...process.env, OPPER_HOME: home, NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", ...extra };
    for (const name of ["OPPER_API_KEY", "OPPER_BASE_URL", "OPPER_DEPLOYMENT"]) if (!(name in extra)) delete env[name];
    return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      const child = execFile(process.execPath, ["--import", "tsx", ...(bootstrap ? ["--import", bootstrap] : []), "src/index.ts", ...args], { cwd: ROOT, env },
        (error, stdout, stderr) => done({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr }));
      child.stdin?.end();
    });
  }
  it("login -d evroc activates the matching profile for later bare commands", async () => {
    seed();
    expect((await run(["login", "-d", "evroc"])).code).toBe(0);
    const active = await run(["whoami"]);
    expect(active.code).toBe(0);
    expect(active.stdout).toContain("evroc@example.invalid");
    expect(active.stdout).toContain("https://api.evroc.on.opper.ai");
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).defaultKey).toBe("work");
    expect((await run(["config", "use", "default"])).code).toBe(0);
    expect((await run(["whoami"])).stdout).toContain("main@example.invalid");
  }, 60_000);
  it("a deployment override selects a matching credential without changing the active profile", async () => {
    seed();
    expect((await run(["-d", "evroc", "whoami"])).stdout).toContain("evroc@example.invalid");
    expect((await run(["whoami"])).stdout).toContain("main@example.invalid");
    const mismatch = await run(["-d", "evroc", "--key", "default", "whoami"]);
    expect(mismatch.code).toBe(8);
    expect(mismatch.stderr).toContain("another deployment");
  }, 60_000);
  it("can repair or select slots even when deployment selection is ambiguous", async () => {
    seed();
    const path = join(home, "config.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.keys.another = { apiKey: "second", baseUrl: "https://api.evroc.on.opper.ai" };
    writeFileSync(path, JSON.stringify(config));
    const switched = await run(["config", "use", "work"], { OPPER_DEPLOYMENT: "evroc" });
    expect(switched.code, switched.stderr).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8")).defaultKey).toBe("work");
    config.defaultKey = "default";
    config.keys = { default: config.keys.default, evroc: { apiKey: "custom", baseUrl: "https://custom.example" } };
    writeFileSync(path, JSON.stringify(config));
    expect((await run(["config", "remove", "evroc"], { OPPER_DEPLOYMENT: "evroc" })).code).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8")).keys.evroc).toBeUndefined();
  }, 60_000);
  it("supports deployment env selection independently of the saved account", async () => {
    seed();
    const result = await run(["whoami"], { OPPER_API_KEY: "synthetic-env", OPPER_DEPLOYMENT: "evroc" });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("OPPER_API_KEY");
    expect(result.stdout).toContain("https://api.evroc.on.opper.ai");
    expect(result.stdout).not.toContain("main@example.invalid");
    expect(result.stdout).not.toContain("synthetic-env");
  }, 60_000);

  it("uses the real login SDK over HTTP and keeps fresh-process model requests on the approved deployment", async () => {
    const requests: Array<{ origin: string; path: string; authorization?: string; form: URLSearchParams }> = [];
    let tokenCount = 0;
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const origin = String(request.headers["x-fixture-origin"]);
      const path = request.url!;
      const form = new URLSearchParams(body);
      requests.push({ origin, path, ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}), form });
      response.setHeader("Content-Type", "application/json");
      if (path === "/oauth/device") {
        response.end(JSON.stringify({ device_code: "fixture-device", user_code: "TEST", verification_uri: "https://evroc.on.opper.ai/device", expires_in: 30, interval: 0 }));
      } else if (path === "/oauth/device/token") {
        tokenCount++;
        response.end(JSON.stringify({ api_key: `fixture-key-${tokenCount}`, credential_id: `fixture-id-${tokenCount}`, org_id: 42, user: { email: "fixture@example.invalid", name: "Fixture" } }));
      } else if (path === "/v3/models?limit=0") {
        response.end(JSON.stringify({ models: [{ id: origin.includes("evroc") ? "evroc-fixture" : "main-fixture" }] }));
      } else { response.writeHead(404).end(JSON.stringify({ error: "Unexpected fixture path" })); }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP fixture address");
    const bootstrap = join(home, "fixture.mjs");
    writeFileSync(bootstrap, `
      import childProcess from "node:child_process";
      import { EventEmitter } from "node:events";
      import { syncBuiltinESMExports } from "node:module";
      const spawn = childProcess.spawn;
      childProcess.spawn = (command, ...args) => {
        if (command === "open" || command === "xdg-open") return Object.assign(new EventEmitter(), { unref() {} });
        return spawn(command, ...args);
      };
      syncBuiltinESMExports();
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (!["https://api.opper.ai", "https://api.evroc.on.opper.ai"].includes(url.origin)) throw new Error("Unexpected outgoing origin");
        const headers = new Headers(init?.headers);
        headers.set("x-fixture-origin", url.origin);
        return nativeFetch(new URL(url.pathname + url.search, "http://127.0.0.1:${address.port}"), { ...init, headers });
      };
    `);
    try {
      const login = await run(["login", "-d", "evroc"], {}, bootstrap);
      expect(login.code, login.stderr).toBe(0);
      const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
      expect(saved.defaultKey).toBe("evroc");
      expect(saved.keys.evroc.baseUrl).toBe("https://api.evroc.on.opper.ai");
      expect(saved.keys.evroc.deployment).toBe("evroc");
      const models = await run(["models", "list", "--json"], {}, bootstrap);
      expect(models.code, models.stderr).toBe(0);
      expect(JSON.parse(models.stdout)[0].id).toBe("evroc-fixture");
      expect((await run(["login", "-d", "evroc", "--renew"], {}, bootstrap)).code).toBe(0);
      expect(requests.findLast((item) => item.path === "/oauth/device")?.form.get("current_credential_id")).toBe("fixture-id-1");
      expect((await run(["models", "list", "--json"], {}, bootstrap)).code).toBe(0);
      const lastModel = requests.findLast((item) => item.path.startsWith("/v3/models"));
      expect(lastModel).toMatchObject({ origin: "https://api.evroc.on.opper.ai", authorization: "Bearer fixture-key-2" });
      expect(requests.filter((item) => item.path.startsWith("/oauth/")).every((item) => item.form.get("client_id") === "opper_app_CK-rOJsIIPXlzYYE7MWFCQ")).toBe(true);
      expect(requests.every((item) => item.origin === "https://api.evroc.on.opper.ai")).toBe(true);
      const before = requests.length;
      const mismatch = await run(["-d", "main", "--key", "evroc", "models", "list"], {}, bootstrap);
      expect(mismatch.code).toBe(8);
      expect(requests).toHaveLength(before);
      expect((await run(["login", "-d", "main"], {}, bootstrap)).code).toBe(0);
      const mainModels = await run(["models", "list", "--json"], {}, bootstrap);
      expect(JSON.parse(mainModels.stdout)[0].id).toBe("main-fixture");
      expect((await run(["config", "use", "evroc"], {}, bootstrap)).code).toBe(0);
      const evrocAgain = await run(["models", "list", "--json"], {}, bootstrap);
      expect(JSON.parse(evrocAgain.stdout)[0].id).toBe("evroc-fixture");
    } finally {
      await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
    }
  }, 60_000);

  it("rejects unknown deployment names and exposes -d in help", async () => {
    const result = await run(["-d", "eu", "whoami"]);
    expect(result.code).toBe(8);
    expect(result.stderr).toContain("main or evroc");
    expect((await run(["--help"])).stdout).toContain("-d, --deployment <name>");
  }, 60_000);
});
