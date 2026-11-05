import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Runs the real entry point against a local server: exit codes, what lands on
// which stream and how stdin arrives only exist at the process boundary.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const KEY = "op_test_never_print_me";
const SPAWN_TIMEOUT = 60_000;

interface Request {
  path: string;
  headers: IncomingHttpHeaders;
  body: { model: string; stream?: boolean; max_tokens?: number; messages: { role: string; content: string }[] };
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

describe("opper call", () => {
  let server: Server;
  let baseUrl: string;
  let home: string;
  let requests: Request[];
  let respond: (res: ServerResponse) => void;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        requests.push({
          path: req.url ?? "",
          headers: req.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Request["body"],
        });
        respond(res);
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((done) => server.close(done));
  });

  beforeEach(() => {
    requests = [];
    home = mkdtempSync(join(tmpdir(), "opper-call-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function run(args: string[], stdin?: string): Promise<Run> {
    return new Promise((done, fail) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "call", ...args], {
        cwd: ROOT,
        env: {
          ...process.env,
          OPPER_API_KEY: KEY,
          OPPER_BASE_URL: baseUrl,
          OPPER_HOME: home,
          NO_UPDATE_NOTIFIER: "1",
          NO_COLOR: "1",
        },
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", fail);
      child.on("close", (code) => done({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }));
      child.stdin.end(stdin ?? "");
    });
  }

  function json(content: string, finishReason: string): (res: ServerResponse) => void {
    return (res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        model: "served-model",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        cost: 0.5,
      }));
    };
  }

  function sse(...frames: unknown[]): (res: ServerResponse) => void {
    return (res) => {
      res.setHeader("Content-Type", "text/event-stream");
      for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
      res.end("data: [DONE]\n\n");
    };
  }

  it("calls chat completions with the stored context and keeps stdout to the answer", async () => {
    respond = json("the answer", "stop");

    const result = await run(["my-fn", "be brief", "the input", "--model", "some-model"]);

    expect(result).toEqual({
      code: 0,
      stdout: "the answer\n",
      stderr: "served-model: 1 input + 2 output = 3 tokens, $0.500000\n",
    });
    const [request] = requests;
    expect(request?.path).toBe("/v3/compat/chat/completions");
    expect(request?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(request?.headers["x-opper-name"]).toBe("my-fn");
    expect(request?.body).toMatchObject({
      model: "some-model",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "the input" },
      ],
    });
  }, SPAWN_TIMEOUT);

  it("takes a large input through stdin", async () => {
    respond = json("ok", "stop");
    // Well over any single argument limit: 128 KiB on Linux, 1 MiB on macOS.
    const input = "line of input\n".repeat(200_000).trim();

    const result = await run(["my-fn", "summarize"], input);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("ok\n");
    expect(requests[0]?.body.messages[1]).toEqual({ role: "user", content: input });
  }, SPAWN_TIMEOUT);

  it("fails with a usage error when neither an argument nor stdin has input", async () => {
    const result = await run(["my-fn", "summarize"]);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No input provided");
    expect(requests).toEqual([]);
  }, SPAWN_TIMEOUT);

  it("exits non-zero on a cut-off answer and still delivers all of it to stdout", async () => {
    // A cut-off answer is long by nature, longer than a pipe buffer holds.
    const partial = "x".repeat(4 * 1024 * 1024);
    respond = json(partial, "length");

    const result = await run(["my-fn", "write a lot", "go"]);

    expect(result.code).toBe(6);
    expect(result.stdout).toBe(`${partial}\n`);
    expect(result.stderr).toContain("3 tokens");
    expect(result.stderr).toContain("finish_reason: length");
  }, SPAWN_TIMEOUT);

  it("--max-tokens reaches the request as a number", async () => {
    respond = json("ok", "stop");

    const result = await run(["my-fn", "be brief", "go", "--max-tokens", "100"]);

    expect(result.code).toBe(0);
    expect(requests[0]?.body.max_tokens).toBe(100);
  }, SPAWN_TIMEOUT);

  it.each(["0", "-5", "abc", "1.5", "1e3", "9007199254740993"])("refuses --max-tokens %s before calling the API", async (value) => {
    respond = json("ok", "stop");

    const result = await run(["my-fn", "be brief", "go", "--max-tokens", value]);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--max-tokens");
    expect(requests).toEqual([]);
  }, SPAWN_TIMEOUT);

  it("--stream prints the deltas and exits zero on a finished answer", async () => {
    respond = sse(
      { model: "served-model", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
      { model: "served-model", choices: [{ index: 0, delta: { content: "strea" } }] },
      { model: "served-model", choices: [{ index: 0, delta: { content: "med" } }] },
      { model: "served-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], cost: 0.5 },
      { model: "served-model", choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }, cost: 0.5 },
    );

    const result = await run(["my-fn", "be brief", "go", "--stream"]);

    expect(result).toEqual({
      code: 0,
      stdout: "streamed\n",
      stderr: "served-model: 1 input + 2 output = 3 tokens, $0.500000\n",
    });
    expect(requests[0]?.body.stream).toBe(true);
    expect(requests[0]?.headers["x-opper-name"]).toBe("my-fn");
  }, SPAWN_TIMEOUT);

  it("--stream exits non-zero on a cut-off answer", async () => {
    respond = sse(
      { choices: [{ index: 0, delta: { content: "partial" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
    );

    const result = await run(["my-fn", "write a lot", "go", "--stream"]);

    expect(result.code).toBe(6);
    expect(result.stdout).toBe("partial\n");
    expect(result.stderr).toContain("finish_reason: length");
  }, SPAWN_TIMEOUT);

  it("never prints the key, not even on an API error", async () => {
    respond = (res) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { message: "boom" } }));
    };

    const result = await run(["my-fn", "be brief", "go"]);

    expect(result.code).toBe(6);
    expect(result.stderr).toContain("boom");
    expect(`${result.stdout}${result.stderr}`).not.toContain(KEY);
  }, SPAWN_TIMEOUT);
});
