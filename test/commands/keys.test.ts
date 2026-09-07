import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const authFlow = vi.fn();
vi.mock("../../src/auth/mcp-key-flow.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/auth/mcp-key-flow.js")>(), withMcpKeyAuthorization: authFlow,
}));
const { keysCreateCommand } = await import("../../src/commands/keys.js");
const project = "4d4bd7fc-3b7b-47da-bc56-b9437e8f31cb";
const secret = "op-ABCDEFGHIJKLMNOPQRST";
const fetchMock = vi.fn();
let directory: string;
let log: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "opper-key-test-")));
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  authFlow.mockReset().mockImplementation(async (_url, action) => action("private-delegated-token"));
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

function opts() { return { project, name: "App key", output: join(directory, ".env.local"), mcpUrl: "http://localhost:8080/mcp" }; }
function projectResponse() { return Response.json({ data: { uuid: project, name: "App" } }); }
function created() { return Response.json({ data: { id: 42, name: "App key", key: secret } }, { status: 201 }); }

describe("private runtime key creation", () => {
  it("writes a 0600 env file and prints only whitelisted metadata", async () => {
    fetchMock.mockResolvedValueOnce(projectResponse()).mockResolvedValueOnce(created());
    await keysCreateCommand(opts());
    expect(await readFile(opts().output, "utf8")).toBe(`OPPER_API_KEY=${secret}\n`);
    expect((await stat(opts().output)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual([".env.local"]);
    const output = log.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(output).not.toMatch(/ABCDEFGHIJKLMNOPQRST|private-delegated-token/);
    expect(JSON.parse(output)).toEqual({ id: 42, name: "App key", project_uuid: project, output: opts().output });
    const [url, request] = fetchMock.mock.calls[1]!;
    expect(url.toString()).toBe(`http://localhost:8080/user/v1/projects/${project}/api-keys`);
    expect(JSON.parse(request.body)).toMatchObject({ name: "App key", return_secret: true, idempotency_key: expect.any(String) });
  });

  it.each(["existing file", "symlink"])("rejects %s before browser authorization", async (kind) => {
    await writeFile(join(directory, "existing"), "keep me");
    if (kind === "symlink") await symlink(join(directory, "existing"), opts().output);
    else await writeFile(opts().output, "keep me");
    await expect(keysCreateCommand(opts())).rejects.toThrow(/already exists/);
    expect(authFlow).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readFile(opts().output, "utf8")).toBe("keep me");
  });

  it("revokes only the newly created key if another file appears during approval", async () => {
    authFlow.mockImplementationOnce(async (_url, action) => { await writeFile(opts().output, "other work"); return action("private-delegated-token"); });
    fetchMock.mockResolvedValueOnce(projectResponse()).mockResolvedValueOnce(created()).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(keysCreateCommand(opts())).rejects.toThrow(/could not be saved/i);
    expect(await readFile(opts().output, "utf8")).toBe("other work");
    expect(fetchMock.mock.calls[2]![0].toString()).toBe(`http://localhost:8080/user/v1/projects/${project}/api-keys/42`);
    expect(fetchMock.mock.calls[2]![1].method).toBe("DELETE");
    expect(log).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([".env.local"]);
  });

  it("uses the same idempotency ID after an uncertain response and revokes a secretless replay", async () => {
    fetchMock.mockResolvedValueOnce(projectResponse())
      .mockRejectedValueOnce(new Error(`transport leaked ${secret}`))
      .mockResolvedValueOnce(Response.json({ data: { id: 42 }, meta: { idempotency_replayed: true, key_retrievable: false } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(keysCreateCommand(opts())).rejects.toThrow(/secret was not received/i);
    const original = JSON.parse(fetchMock.mock.calls[1]![1].body);
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body)).toEqual(original);
    expect(fetchMock.mock.calls[3]![1].method).toBe("DELETE");
    expect(await readdir(directory)).toEqual([]);
  });

  it("does not create a key when the project is outside the approved organization", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: `private ${secret}` }, { status: 404 }));
    await expect(keysCreateCommand(opts())).rejects.toThrow(/project is not available/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("reports a recoverable request ID after both responses are lost without exposing errors", async () => {
    const idempotencyKey = "6ba3d2bf-35e7-48b6-bd24-48064df1acbe";
    fetchMock.mockResolvedValueOnce(projectResponse()).mockRejectedValue(new Error(`private ${secret}`));
    await expect(keysCreateCommand({ ...opts(), idempotencyKey })).rejects.toMatchObject({
      message: "The key creation outcome could not be confirmed.", hint: expect.stringContaining(`--idempotency-key ${idempotencyKey}`),
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).idempotency_key).toBe(idempotencyKey);
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body).idempotency_key).toBe(idempotencyKey);
    expect(await readdir(directory)).toEqual([]);
  });

  it("reports the exact new key needing cleanup if rollback fails", async () => {
    authFlow.mockImplementationOnce(async (_url, action) => { await writeFile(opts().output, "other work"); return action("private-delegated-token"); });
    fetchMock.mockResolvedValueOnce(projectResponse()).mockResolvedValueOnce(created())
      .mockResolvedValueOnce(Response.json({ error: `private ${secret}` }, { status: 500 }));
    await expect(keysCreateCommand(opts())).rejects.toThrow(/key 42 could not be revoked/);
    expect(await readFile(opts().output, "utf8")).toBe("other work");
    expect(log).not.toHaveBeenCalled();
  });

  it("revokes a key received during cancellation without installing it", async () => {
    const response = created();
    vi.spyOn(response, "json").mockImplementation(async () => {
      process.emit("SIGINT");
      return { data: { id: 42, key: secret } };
    });
    fetchMock.mockResolvedValueOnce(projectResponse()).mockResolvedValueOnce(response)
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(keysCreateCommand(opts())).rejects.toThrow(/cancelled.*new key was revoked/);
    expect(fetchMock.mock.calls[2]![1].method).toBe("DELETE");
    expect(await readdir(directory)).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it("redacts unexpected errors before the global error printer can see them", async () => {
    authFlow.mockRejectedValueOnce(new Error(`OAuth server echoed ${secret}`));
    await expect(keysCreateCommand(opts())).rejects.toThrow("The private key setup could not be completed.");
    expect(await readdir(directory)).toEqual([]);
  });
});
