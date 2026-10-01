// Real HTTP CLI acceptance against a disposable backend. No production keys.
// OPPER_E2E_FIXTURE points to {apiKey, orgId, projectUuid, baseUrl?, ...}.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

assert(process.env.OPPER_E2E_FIXTURE, "Set OPPER_E2E_FIXTURE to the disposable backend fixture JSON");
const fixture = JSON.parse(await readFile(process.env.OPPER_E2E_FIXTURE, "utf8"));
assert(fixture.apiKey && fixture.orgId && fixture.projectUuid, "Fixture must contain apiKey, orgId and projectUuid");
const baseUrl = fixture.baseUrl ?? fixture.apiHost ?? "http://localhost:8184";
assert(["localhost", "127.0.0.1"].includes(new URL(baseUrl).hostname), "Acceptance script requires a loopback backend");
const home = await mkdtemp(join(tmpdir(), "opper-org-personal-http-"));
const cli = join(process.cwd(), "dist", "index.js");
const env = { ...process.env, HOME: home, OPPER_HOME: join(home, ".opper"), OPPER_EDITOR_HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share") };
for (const name of ["OPPER_API_KEY", "OPPER_BASE_URL", "OPPER_PROJECT_UUID", "OPPER_KEY_SLOT", "OPPER_CLI_LAUNCH_OPENCODE", "OPENCODE_CONFIG_CONTENT"]) delete env[name];
async function run(args, overrides = {}, expected = 0, executable = process.execPath) {
  const result = await new Promise((resolve) => {
    const child = execFile(executable, executable === process.execPath ? [cli, ...args] : args,
      { cwd: home, env: { ...env, ...overrides }, timeout: 30_000, maxBuffer: 8_000_000 },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
    child.stdin?.end();
  });
  // Do not emit raw config/credentials or successful catalog contents.
  assert.equal(result.code, expected, `Unexpected exit for ${args.join(" ")}: ${result.stderr.slice(0, 500)}`);
  return result;
}
async function saveSlot(extra = {}) {
  await mkdir(env.OPPER_HOME, { recursive: true });
  await writeFile(join(env.OPPER_HOME, "config.json"), JSON.stringify({ version: 1, defaultKey: "default", keys: {
    default: { apiKey: fixture.apiKey, orgId: fixture.orgId, baseUrl, source: "device-flow", ...extra },
  } }), { mode: 0o600 });
}
try {
  await saveSlot();
  await run(["models", "list"]);
  await run(["usage", "list"]);
  await run(["traces", "list"]);
  for (const args of [["functions", "list"], ["indexes", "list"], ["ask", "hello"]]) {
    assert.match((await run(args, {}, 8)).stderr, /requires a project/);
  }
  for (const args of [["functions", "list"], ["indexes", "list"], ["traces", "list"], ["models", "list"]]) {
    await run(["--project-uuid", fixture.projectUuid, ...args]);
  }
  await run(["config", "project", "default", fixture.projectUuid]);
  await run(["functions", "list"]);
  await run(["indexes", "list"]);
  await run(["traces", "list"]);
  await run(["config", "project", "default"]);
  await run(["--project-uuid", "malformed", "functions", "list"], {}, 8);
  if (fixture.foreignProjectUuid) await run(["--project-uuid", fixture.foreignProjectUuid, "functions", "list"], {}, 6);

  // A stored expired slot on another host cannot contaminate an environment key.
  await saveSlot({ baseUrl: "http://localhost:1", expiresAt: "2020-01-01", defaultProjectUuid: fixture.projectUuid });
  const independent = { OPPER_API_KEY: fixture.apiKey, OPPER_BASE_URL: baseUrl };
  await run(["models", "list"], independent);
  assert.match((await run(["functions", "list"], independent, 8)).stderr, /requires a project/);
  await run(["--project-uuid", fixture.projectUuid, "functions", "list"], independent);
  await saveSlot({ expiresAt: fixture.expiresAt, credentialId: fixture.credentialId });
  if (process.env.OPPER_E2E_ASK === "1") {
    const skills = join(home, ".agents", "skills", "opper-acceptance");
    await mkdir(skills, { recursive: true });
    await writeFile(join(skills, "SKILL.md"), "# Synthetic local acceptance documentation\nUse the local test provider for this acceptance check.\n");
    const answer = await run(["--project-uuid", fixture.projectUuid, "ask", "--model", process.env.OPPER_E2E_MODEL, "Say hello for CLI SDK ask acceptance"]);
    assert.match(answer.stdout, /local provider success/, "Real structured SDK ask did not return its final answer");
    assert.match(answer.stdout, /\([1-9]\d* tokens · [1-9]\d* requests?\)/, "SDK ask must report actual gateway usage even under ZDR");
  }
  await run(["editors", "opencode", "--login-bridge"]);
  const untargeted = JSON.parse((await run(["debug", "config"], {}, 0, "opencode")).stdout);
  assert.equal(untargeted.provider?.opper?.options?.apiKey, fixture.apiKey);
  assert.equal(untargeted.provider?.opper?.options?.headers?.["X-Opper-Project"], undefined);
  if (process.env.OPPER_E2E_MODEL) {
    assert.ok(untargeted.provider?.opper?.whitelist?.includes(process.env.OPPER_E2E_MODEL));
    const answer = await run(["run", "--model", `opper/${process.env.OPPER_E2E_MODEL}`, "Say hello for CLI organization acceptance"], {}, 0, "opencode");
    assert.ok(answer.stdout.trim(), "Organization inference returned no output");
  }
  await run(["--project-uuid", fixture.projectUuid, "editors", "opencode", "--login-bridge"]);
  const targeted = JSON.parse((await run(["debug", "config"], {}, 0, "opencode")).stdout);
  assert.equal(targeted.provider?.opper?.options?.headers?.["X-Opper-Project"], fixture.projectUuid);
  assert.ok(targeted.provider?.opper?.whitelist?.length, "Real backend model discovery returned no models");
  if (process.env.OPPER_E2E_MODEL) {
    const answer = await run(["run", "--model", `opper/${process.env.OPPER_E2E_MODEL}`, "Say hello for CLI project acceptance"], {}, 0, "opencode");
    assert.ok(answer.stdout.trim(), "Targeted inference returned no output");
  }
  console.log("Real backend CLI acceptance passed: org models/usage/traces, project resources and defaults, negative scope paths, env isolation, real OpenCode discovery/inference" + (process.env.OPPER_E2E_ASK === "1" ? ", structured SDK ask and usage." : "."));
} finally {
  await rm(home, { recursive: true, force: true });
}
