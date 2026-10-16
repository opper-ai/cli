import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const { ensurePrivateStateDirectory, ensurePrivateStateFile } = await import("../../src/desktop/private-state.js");

const PRIVATE_PATH = "C:\\Users\\synthetic-private-user\\proxy-state\\connection.json";
const RAW_STDOUT = "synthetic-secret-raw-stdout";
const RAW_STDERR = "synthetic-secret-raw-stderr";
const RAW_ERROR = "synthetic-secret-native-error";
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

interface NativeFailure extends Error {
  code?: string | number | null;
  killed?: boolean;
  signal?: string | null;
}

function failure(properties: Omit<NativeFailure, "name" | "message"> = {}): NativeFailure {
  return Object.assign(new Error(`${RAW_ERROR}: ${PRIVATE_PATH}`), properties);
}

function respond(cause: NativeFailure | null, stdout: string, stderr = RAW_STDERR): PassThrough {
  const stdin = new PassThrough();
  execFileMock.mockImplementation((_executable, _args, _options, callback) => {
    queueMicrotask(() => callback(cause, stdout, stderr));
    return { stdin };
  });
  return stdin;
}

async function expectSafeConflict(hint: RegExp): Promise<Error & { code: string; hint?: string }> {
  const outcome = await ensurePrivateStateFile(PRIVATE_PATH, true).then(
    () => { throw new Error("Native checker failure was accepted"); },
    error => error as Error & { code: string; hint?: string },
  );
  expect(outcome).toMatchObject({ code: "AGENT_CONFIG_CONFLICT", hint: expect.stringMatching(hint) });
  const displayed = `${outcome.message}\n${outcome.hint ?? ""}\n${outcome.stack ?? ""}`;
  for (const sensitive of [PRIVATE_PATH, RAW_STDOUT, RAW_STDERR, RAW_ERROR]) expect(displayed).not.toContain(sensitive);
  return outcome;
}

describe("Windows private-state checker process failures", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    vi.stubEnv("SystemRoot", "C:\\Windows");
    vi.stubEnv("WINDIR", "C:\\Windows");
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", platformDescriptor);
    vi.unstubAllEnvs();
  });

  it("accepts a valid successful native response and keeps the checker bounded", async () => {
    const stdin = respond(null, ' \r\n{"ok":true}\r\n');
    const input: Buffer[] = [];
    stdin.on("data", chunk => input.push(chunk));
    await expect(ensurePrivateStateFile(PRIVATE_PATH, true)).resolves.toBeUndefined();
    const [executable, args, options] = execFileMock.mock.calls[0]!;
    expect(executable).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(args.join(" ")).not.toContain(PRIVATE_PATH);
    expect(options).toEqual({ timeout: 15_000, maxBuffer: 16_384, windowsHide: true });
    expect(JSON.parse(Buffer.concat(input).toString("utf8"))).toEqual({ path: PRIVATE_PATH, kind: "file", create: true });
  });

  it("preserves genuine native ACL rejection without mislabeling it as a process failure", async () => {
    respond(failure({ code: 1 }), '{"ok":false,"code":"AGENT_CONFIG_CONFLICT"}');
    const outcome = await ensurePrivateStateDirectory(PRIVATE_PATH, true).catch(error => error);
    expect(outcome).toMatchObject({ code: "AGENT_CONFIG_CONFLICT", message: expect.stringMatching(/private.*owned.*symlink or junction/i) });
    expect(outcome.hint ?? "").not.toMatch(/timed out|could not start|invalid response/i);
    for (const sensitive of [PRIVATE_PATH, RAW_STDOUT, RAW_STDERR, RAW_ERROR]) {
      expect(`${outcome.message}\n${outcome.hint ?? ""}`).not.toContain(sensitive);
    }
  });

  it("preserves a genuine native ENOENT result", async () => {
    respond(failure({ code: 1 }), '{"ok":false,"code":"ENOENT"}');
    await expect(ensurePrivateStateFile(PRIVATE_PATH, true)).rejects.toMatchObject({ code: "ENOENT", message: "No local proxy state found." });
  });

  it.each(["", RAW_STDOUT, "null", '"unexpected"', "[]", '{"ok":"true"}', '{"ok":false,"code":"unexpected"}'])("fails closed on invalid native output %j", async stdout => {
    respond(null, stdout);
    await expectSafeConflict(/invalid response/i);
  });

  it.each([
    { killed: true, signal: "SIGTERM", code: null },
    { killed: true, signal: "SIGKILL", code: null },
    { code: "ETIMEDOUT" },
  ])("distinguishes a timeout or killed checker: %j", async properties => {
    respond(failure(properties), RAW_STDOUT);
    await expectSafeConflict(/timed out|terminated/i);
  });

  it("does not trust partial native JSON after the checker is killed", async () => {
    respond(failure({ killed: true, signal: "SIGTERM" }), '{"ok":false,"code":"ENOENT"}');
    await expectSafeConflict(/timed out|terminated/i);
  });

  it.each(["ENOENT", "EACCES", "EPERM"])("distinguishes a checker that cannot start (%s)", async code => {
    respond(failure({ code }), RAW_STDOUT);
    await expectSafeConflict(/could not start/i);
  });

  it("sanitizes synchronous checker startup failures", async () => {
    execFileMock.mockImplementation(() => { throw failure({ code: "ENOENT" }); });
    await expectSafeConflict(/could not start/i);
  });

  it("does not accept a forged success or missing-state response after startup fails", async () => {
    for (const stdout of ['{"ok":true}', '{"ok":false,"code":"ENOENT"}']) {
      respond(failure({ code: "ENOENT" }), stdout);
      await expectSafeConflict(/could not start/i);
    }
  });

  it("fails closed on excessive output without surfacing the native output", async () => {
    respond(failure({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), RAW_STDOUT.repeat(20_000));
    await expectSafeConflict(/invalid response/i);
  });

  it("does not trust a truncated JSON result after exceeding the output bound", async () => {
    respond(failure({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), '{"ok":false,"code":"ENOENT"}');
    await expectSafeConflict(/invalid response/i);
  });
});
