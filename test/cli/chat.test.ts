import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
let server: Server;
let home: string;
let base: string;
let status: number;
let response: unknown;
let sse: string | null;
let requests: { path: string; authorization?: string; project?: string; body: Record<string, unknown> }[];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "opper-chat-cli-"));
  requests = []; status = 200; sse = null;
  response = { choices: [{ message: { content: "fixture answer" }, finish_reason: "stop" }] };
  server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    requests.push({ path: req.url!, authorization: req.headers.authorization,
      project: req.headers["x-opper-project"] as string | undefined, body: JSON.parse(text) });
    res.writeHead(status, { "Content-Type": sse === null ? "application/json" : "text/event-stream" });
    res.end(sse ?? JSON.stringify(response));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  base = `http://127.0.0.1:${address.port}`;
  writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, defaultKey: "fixture", keys: {
    fixture: { apiKey: "fixture-secret", baseUrl: base, source: "device-flow", orgId: 1 },
  } }));
});
afterEach(async () => { await new Promise<void>((done) => server.close(() => done())); rmSync(home, { recursive: true, force: true }); });

function run(args: string[], input = "") {
  const env = { ...process.env, OPPER_HOME: home, NO_COLOR: "1", NO_UPDATE_NOTIFIER: "1" };
  for (const name of ["OPPER_API_KEY", "OPPER_BASE_URL", "OPPER_DEPLOYMENT", "OPPER_PROJECT_UUID"]) delete env[name];
  return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    const child = execFile(process.execPath, ["--import", "tsx", "src/index.ts", "--no-telemetry", ...args],
      { cwd: ROOT, env, timeout: 15_000 }, (error, stdout, stderr) => done({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0, stdout, stderr }));
    child.stdin?.end(input);
  });
}

describe("chat CLI through real HTTP", () => {
  it("accepts a prompt, -m and system instructions without requiring a project", async () => {
    const result = await run(["chat", "hello", "-m", "fixture/model", "--system", "be concise"]);
    expect(result).toEqual({ code: 0, stdout: "fixture answer\n", stderr: "" });
    expect(requests).toEqual([{ path: "/v3/compat/chat/completions", authorization: "Bearer fixture-secret", project: undefined,
      body: { model: "fixture/model", messages: [{ role: "system", content: "be concise" }, { role: "user", content: "hello" }], stream: false } }]);
  });
  it("preserves piped whitespace and combines prompt and stdin with a blank line", async () => {
    const result = await run(["chat", "summarise", "--model", "fixture/model"], "  line one\nline two\n");
    expect(result.code, result.stderr).toBe(0);
    expect(requests[0]!.body.messages).toEqual([{ role: "user", content: "summarise\n\n  line one\nline two\n" }]);
  });
  it("accepts stdin alone", async () => {
    expect((await run(["chat", "-m", "fixture/model"], "\n  hello\n")).code).toBe(0);
    expect(requests[0]!.body.messages).toEqual([{ role: "user", content: "\n  hello\n" }]);
  });
  it("supports an explicit project without leaking saved legacy project bindings", async () => {
    const project = "11111111-1111-4111-8111-111111111111";
    expect((await run(["--project-uuid", project, "chat", "hello", "-m", "fixture/model"])).code).toBe(0);
    expect(requests[0]!.project).toBe(project);
  });
  it.each([["chat", "hello"], ["chat", "-m", "fixture/model"], ["chat", "  ", "-m", "fixture/model"], ["chat", "hello", "-m", " "]])("rejects invalid input %j without a request", async (...args) => {
    const result = await run(args);
    expect(result.code).not.toBe(0); expect(result.stdout).toBe(""); expect(requests).toHaveLength(0);
  });
  it("streams only text deltas", async () => {
    sse = 'data: {"choices":[{"delta":{"role":"assistant","content":"hello "},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{"content":"world"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const result = await run(["chat", "hello", "-m", "fixture/model", "--stream"]);
    expect(result).toEqual({ code: 0, stdout: "hello world\n", stderr: "" });
    expect(requests[0]!.body.stream).toBe(true);
  });
  it("reports API errors on stderr and exits nonzero", async () => {
    status = 429; response = { error: { message: "fixture rate limit" } };
    const result = await run(["chat", "hello", "-m", "fixture/model"]);
    expect(result.code).not.toBe(0);expect(result.stdout).toBe("");expect(result.stderr).toContain("fixture rate limit");
  });
  it.each([{ args: [] }, { args: ["my-function", "instructions", "input", "--model", "old/model", "--stream"] }])("gives migration guidance for old call $args before reading malformed auth", async ({ args }) => {
    writeFileSync(join(home, "config.json"), "{broken JSON");
    const result = await run(["call", ...args]);
    expect(result.code).toBe(8);expect(result.stdout).toBe("");expect(result.stderr).toContain("opper chat");expect(result.stderr).not.toContain("Malformed config");expect(requests).toHaveLength(0);
  });
});
