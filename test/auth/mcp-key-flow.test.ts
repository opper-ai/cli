import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEY_SETUP_SCOPES, withMcpKeyAuthorization } from "../../src/auth/mcp-key-flow.js";
import { OpperError } from "../../src/errors.js";

const browserSpawn = vi.hoisted(() => vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })));
vi.mock("node:child_process", async () => ({
  ...await vi.importActual<typeof import("node:child_process")>("node:child_process"),
  spawn: browserSpawn,
}));

let server: Server;
let origin: string;
let directory: string;
let authorization: URL;
let registrations: number;
let exchanges: number;
let revoked: string[];
let grantedScope: string | undefined;
let invalidClient: boolean;
let offlineAccessSupported: boolean;
let registrationError: boolean;
let revokeError: boolean;
let revokeFailureFor: string | undefined;
let omitRefreshToken: boolean;
let activeTokens: Set<string>;
let requiresIssuer: boolean;
let revocationQuery: string;
let revocationUrlOverride: string | undefined;
const requests: { path: string; body: string }[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "opper-native-key-test-"));
  vi.stubEnv("OPPER_HOME", directory);
  revocationQuery = ""; revocationUrlOverride = undefined;
  revokeFailureFor = undefined; omitRefreshToken = false; activeTokens = new Set();
  registrations = 0; exchanges = 0; revoked = []; requests.length = 0;
  grantedScope = KEY_SETUP_SCOPES; invalidClient = false; offlineAccessSupported = false; registrationError = false; revokeError = false; requiresIssuer = false;
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ path: request.url!, body });
    const send = (data: unknown, status = 200) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
    if (request.url === "/.well-known/oauth-protected-resource/mcp" || request.url === "/.well-known/oauth-protected-resource") {
      send({ resource: `${origin}/mcp`, authorization_servers: [`${origin}/oauth`] });
    } else if (request.url === "/.well-known/oauth-authorization-server/oauth") {
      send({ issuer: `${origin}/oauth`, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`, revocation_endpoint: revocationUrlOverride ?? `${origin}/oauth/revoke${revocationQuery}`,
        response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["account:read", "projects:read", "projects:write", "projects:delete", "apikeys:read", "apikeys:write", "controls:read", "controls:write", "dynamic_routes:read", "dynamic_routes:write", "runtime:read", "runtime:call", ...(offlineAccessSupported ? ["offline_access"] : [])],
        authorization_response_iss_parameter_supported: requiresIssuer,
      });
    } else if (request.url === "/oauth/register") {
      registrations += 1;
      if (registrationError) send({ error: "invalid_client_metadata", error_description: "PRIVATE-SDK-SECRET" }, 400);
      else send({ ...JSON.parse(body), client_id: "public-cli-client" }, 201);
    } else if (request.url === "/oauth/token") {
      exchanges += 1;
      if (invalidClient) { send({ error: "invalid_client" }, 401); return; }
      const form = new URLSearchParams(body);
      expect(form.get("client_id")).toBe("public-cli-client");
      expect(form.get("resource")).toBe(`${origin}/mcp`);
      expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url")).toBe(authorization.searchParams.get("code_challenge"));
      activeTokens.add("PRIVATE-ACCESS-TOKEN");
      if (!omitRefreshToken) activeTokens.add("PRIVATE-REFRESH-TOKEN");
      send({ access_token: "PRIVATE-ACCESS-TOKEN", ...(omitRefreshToken ? {} : { refresh_token: "PRIVATE-REFRESH-TOKEN" }), token_type: "Bearer", expires_in: 300, scope: grantedScope });
    } else if (request.url?.startsWith("/oauth/revoke")) {
      const token = new URLSearchParams(body).get("token")!;
      revoked.push(token);
      const failed = revokeError || revokeFailureFor === token;
      if (!failed) activeTokens.delete(token); // Deliberately does not cascade.
      send({}, failed ? 500 : 200);
    } else send({ error: "not found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function approve(url: URL, expectedScope = KEY_SETUP_SCOPES) {
  authorization = url;
  expect(url.searchParams.get("scope")).toBe(expectedScope);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  const callback = new URL(url.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", url.searchParams.get("state")!);
  callback.searchParams.set("code", "one-use-code");
  const response = await fetch(callback);
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain("one-use-code");
}

describe("native SDK OAuth for private key setup", () => {
  it("prints a complete manual OAuth URL on Windows and closes the callback after cancellation", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    browserSpawn.mockClear();
    let shown!: (url: URL) => void;
    const shownUrl = new Promise<URL>((resolve) => { shown = resolve; });
    let printed = "";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      printed += String(chunk);
      const line = String(chunk).split("\n").find((value) => value.startsWith("http://"));
      if (line) shown(new URL(line));
      return true;
    });
    const abort = new AbortController();
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      const operation = vi.fn();
      const flow = withMcpKeyAuthorization(new URL(`${origin}/mcp`), operation, { signal: abort.signal, timeoutMs: 2000 });
      const result = flow.catch((error: unknown) => error);
      const url = await shownUrl;
      abort.abort();
      expect(await result).toMatchObject({ code: "AUTH_REQUIRED" });
      expect(printed).toContain("Open this URL in your browser:");
      expect(printed).not.toContain("Opening your browser");
      expect(printed).toContain(url.href);
      expect(url.href).toContain("&");
      expect(url.searchParams.get("scope")).toBe(KEY_SETUP_SCOPES);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("state")).toBeTruthy();
      expect(browserSpawn).not.toHaveBeenCalled();
      expect(operation).not.toHaveBeenCalled();
      expect(exchanges).toBe(0);
      await expect(fetch(url.searchParams.get("redirect_uri")!)).rejects.toThrow();
    } finally {
      abort.abort();
      Object.defineProperty(process, "platform", platform);
      stderr.mockRestore();
      browserSpawn.mockClear();
    }
  });

  it("uses real SDK DCR/PKCE and revokes its temporary grant after the operation", async () => {
    const operation = vi.fn().mockResolvedValue("done");
    await expect(withMcpKeyAuthorization(new URL(`${origin}/mcp`), operation, { onAuthorizationUrl: approve })).resolves.toBe("done");
    expect(operation).toHaveBeenCalledWith("PRIVATE-ACCESS-TOKEN");
    expect(exchanges).toBe(1);
    expect(revoked).toEqual(["PRIVATE-REFRESH-TOKEN", "PRIVATE-ACCESS-TOKEN"]);
    const paths = await readdir(join(directory, "mcp-clients"));
    expect(paths).toHaveLength(1);
    const path = join(directory, "mcp-clients", paths[0]!);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const stored = await readFile(path, "utf8");
    expect(stored).toContain("public-cli-client");
    expect(stored).not.toMatch(/PRIVATE-|code_verifier|state|code_challenge/);
    expect(await readdir(directory)).toEqual(["mcp-clients"]);
  });

  it("reuses only public client registration across runs with fresh callback ports", async () => {
    const operation = vi.fn().mockResolvedValue(undefined);
    await withMcpKeyAuthorization(new URL(`${origin}/mcp`), operation, { onAuthorizationUrl: approve });
    const first = authorization.searchParams.get("redirect_uri");
    await withMcpKeyAuthorization(new URL(`${origin}/mcp`), operation, { onAuthorizationUrl: approve });
    expect(registrations).toBe(1);
    expect(exchanges).toBe(2);
    expect(revoked).toHaveLength(4);
    expect(authorization.searchParams.get("redirect_uri")).not.toBe(first);
  });

  it("accepts omitted token scope as the explicitly requested scopes", async () => {
    grantedScope = undefined;
    const operation = vi.fn().mockResolvedValue("done");
    await expect(withMcpKeyAuthorization(new URL(`${origin}/mcp`), operation, { onAuthorizationUrl: approve })).resolves.toBe("done");
    expect(operation).toHaveBeenCalledOnce();
    expect(revoked).toEqual(["PRIVATE-REFRESH-TOKEN", "PRIVATE-ACCESS-TOKEN"]);
  });

  it("checks the actual authorization scope if the SDK adds offline access and token scope is omitted", async () => {
    offlineAccessSupported = true;
    grantedScope = undefined;
    const operation = vi.fn();
    await expect(withMcpKeyAuthorization(new URL(`${origin}/mcp`), operation, {
      onAuthorizationUrl: (url) => approve(url, `${KEY_SETUP_SCOPES} offline_access`),
    })).rejects.toThrow(/explicitly select both/);
    expect(operation).not.toHaveBeenCalled();
    expect(revoked).toEqual(["PRIVATE-REFRESH-TOKEN", "PRIVATE-ACCESS-TOKEN"]);
  });

  it("evicts an invalid client and requires fresh consent before retrying", async () => {
    await withMcpKeyAuthorization(new URL(`${origin}/mcp`), async () => undefined, { onAuthorizationUrl: approve });
    invalidClient = true;
    const operation = vi.fn();
    await expect(withMcpKeyAuthorization(new URL(`${origin}/mcp`), operation, { onAuthorizationUrl: approve }))
      .rejects.toThrow(/client registration.*removed/i);
    expect(operation).not.toHaveBeenCalled();
    expect(registrations).toBe(1);
    expect(exchanges).toBe(2);
    expect(await readdir(join(directory, "mcp-clients"))).toEqual([]);
    invalidClient = false;
    await withMcpKeyAuthorization(new URL(`${origin}/mcp`), operation, { onAuthorizationUrl: approve });
    expect(registrations).toBe(2);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("preserves an invalid client identity when recovering an uncertain create", async () => {
    await withMcpKeyAuthorization(new URL(`${origin}/mcp`), async () => undefined, { onAuthorizationUrl: approve });
    const files = await readdir(join(directory, "mcp-clients"));
    const path = join(directory, "mcp-clients", files[0]!);
    const before = await readFile(path, "utf8");
    invalidClient = true;
    const operation = vi.fn();
    await expect(withMcpKeyAuthorization(new URL(`${origin}/mcp`), operation, { onAuthorizationUrl: approve, preserveClientRegistration: true }))
      .rejects.toThrow(/recovery.*client registration.*preserved/i);
    expect(operation).not.toHaveBeenCalled();
    expect(registrations).toBe(1);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("does not register a new identity when an uncertain create lost its cache", async () => {
    const operation = vi.fn();
    await expect(withMcpKeyAuthorization(new URL(`${origin}/mcp`), operation, { onAuthorizationUrl: approve, preserveClientRegistration: true }))
      .rejects.toThrow(/original client registration is missing/i);
    expect(operation).not.toHaveBeenCalled();
    expect(registrations).toBe(0);
    expect(exchanges).toBe(0);
  });

  it("explicitly resets only this server and issuer's retained registration", async () => {
    await withMcpKeyAuthorization(new URL(`${origin}/mcp`), async () => undefined, { onAuthorizationUrl: approve });
    const { writeFile } = await import("node:fs/promises");
    const unrelated = join(directory, "mcp-clients", "other-server.json");
    await writeFile(unrelated, "keep this client");
    await withMcpKeyAuthorization(new URL(`${origin}/mcp`), async () => undefined, { onAuthorizationUrl: approve, resetClient: true });
    expect(registrations).toBe(2);
    expect(await readFile(unrelated, "utf8")).toBe("keep this client");
  });

  it("refuses reset during uncertain-create recovery before any request", async () => {
    await expect(withMcpKeyAuthorization(new URL(`${origin}/mcp`), async () => undefined, {
      onAuthorizationUrl: approve, resetClient: true, preserveClientRegistration: true,
    })).rejects.toThrow(/cannot reset.*recover/i);
    expect(requests).toEqual([]);
  });

  it("ignores a callback with the wrong state before accepting the genuine callback", async () => {
    await withMcpKeyAuthorization(new URL(`${origin}/mcp`), async () => undefined, { onAuthorizationUrl: async (url) => {
      const wrong = new URL(url.searchParams.get("redirect_uri")!);
      wrong.search = "state=wrong&code=not-the-code";
      expect((await fetch(wrong)).status).toBe(400);
      expect(exchanges).toBe(0);
      const duplicate = new URL(url.searchParams.get("redirect_uri")!);
      duplicate.searchParams.set("state", url.searchParams.get("state")!);
      duplicate.searchParams.append("code", "one");
      duplicate.searchParams.append("code", "two");
      expect((await fetch(duplicate)).status).toBe(400);
      await approve(url);
    } });
    expect(exchanges).toBe(1);
  });

  it("rejects malformed HTTP callback targets without crashing the flow", async () => {
    await withMcpKeyAuthorization(new URL(`${origin}/mcp`), async () => undefined, { onAuthorizationUrl: async (url) => {
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect(Number(callback.port), "127.0.0.1", () => socket.write("GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"));
        let data = "";
        socket.on("data", (chunk) => { data += chunk.toString(); });
        socket.on("end", () => resolve(data));
        socket.on("error", reject);
      });
      expect(response).toContain("400 Bad Request");
      await approve(url);
    } });
    expect(exchanges).toBe(1);
  });

  it("stops on denial without exchanging a code or running the operation", async () => {
    const operation = vi.fn();
    await expect(withMcpKeyAuthorization(new URL(`${origin}/mcp`), operation, { onAuthorizationUrl: async (url) => {
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      callback.searchParams.set("error", "access_denied");
      await fetch(callback);
    } })).rejects.toThrow(/not approved/);
    expect(operation).not.toHaveBeenCalled();
    expect(exchanges).toBe(0);
    expect(revoked).toEqual([]);
  });

  it("times out and closes its loopback callback without retrying consent", async () => {
    let callbackUrl: string | null = null;
    await expect(withMcpKeyAuthorization(new URL(`${origin}/mcp`), async () => undefined, {
      timeoutMs: 1000, onAuthorizationUrl: (url) => { callbackUrl = url.searchParams.get("redirect_uri"); },
    })).rejects.toThrow(/cancelled or timed out/);
    expect(callbackUrl).not.toBeNull();
    await expect(fetch(callbackUrl!)).rejects.toThrow();
    expect(registrations).toBe(1);
  });

  it.each(["", "projects:read", "projects:read apikeys:write runtime:call"])("revokes an insufficient or excessive grant without creating a key (%s)", async (scope) => {
    grantedScope = scope;
    const operation = vi.fn();
    await expect(withMcpKeyAuthorization(new URL(`${origin}/mcp`), operation, { onAuthorizationUrl: approve })).rejects.toThrow(/explicitly select both/);
    expect(operation).not.toHaveBeenCalled();
    expect(revoked).toEqual(["PRIVATE-REFRESH-TOKEN", "PRIVATE-ACCESS-TOKEN"]);
  });

  it.each([undefined, "https://wrong-issuer.example"])("rejects a missing or mismatched iss before token exchange when advertised (%s)", async (iss) => {
    requiresIssuer = true;
    const operation = vi.fn();
    await expect(withMcpKeyAuthorization(new URL(`${origin}/mcp`), operation, { onAuthorizationUrl: async (url) => {
      authorization = url;
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      callback.searchParams.set("code", "one-use-code");
      if (iss) callback.searchParams.set("iss", iss);
      await fetch(callback);
    } })).rejects.toThrow("Browser authorization could not be completed. Start again from the CLI.");
    expect(exchanges).toBe(0);
    expect(operation).not.toHaveBeenCalled();
  });

  it("revokes on operation failure and redacts untrusted errors", async () => {
    await expect(withMcpKeyAuthorization(new URL(`${origin}/mcp`), async () => { throw new Error("PRIVATE-OPERATION-SECRET"); }, { onAuthorizationUrl: approve }))
      .rejects.toThrow("The private key setup could not be completed.");
    expect(revoked).toEqual(["PRIVATE-REFRESH-TOKEN", "PRIVATE-ACCESS-TOKEN"]);
  });

  it("redacts SDK server error text before returning an error", async () => {
    registrationError = true;
    await expect(withMcpKeyAuthorization(new URL(`${origin}/mcp`), async () => undefined, { onAuthorizationUrl: approve }))
      .rejects.toThrow("Browser authorization could not be completed. Start again from the CLI.");
    expect(exchanges).toBe(0);
  });

  it("preserves a discovered revocation endpoint's fixed query", async () => {
    revocationQuery = "?tenant=tenant-a&mode=cleanup";
    const operation = vi.fn().mockResolvedValue("done");
    await expect(withMcpKeyAuthorization(new URL(`${origin}/mcp`), operation, { onAuthorizationUrl: approve })).resolves.toBe("done");
    expect(operation).toHaveBeenCalledOnce();
    expect(revoked).toEqual(["PRIVATE-REFRESH-TOKEN", "PRIVATE-ACCESS-TOKEN"]);
    expect(requests.find((request) => request.path.startsWith("/oauth/revoke"))?.path).toBe(`/oauth/revoke${revocationQuery}`);
  });

  it.each(["http://example.com/revoke?tenant=a", "https://user:secret@example.com/revoke?tenant=a", "https://example.com/revoke?tenant=a#fragment"])
    ("rejects unsafe discovered revocation endpoints before authorization (%s)", async (endpoint) => {
      revocationUrlOverride = endpoint;
      const operation = vi.fn();
      await expect(withMcpKeyAuthorization(new URL(`${origin}/mcp`), operation, { onAuthorizationUrl: approve })).rejects.toThrow(/authorization could not be completed/i);
      expect(operation).not.toHaveBeenCalled();
      expect(exchanges).toBe(0);
      expect(revoked).toEqual([]);
    });

  it("revokes both tokens when the server does not cascade revocation", async () => {
    await withMcpKeyAuthorization(new URL(`${origin}/mcp`), async () => {
      expect(activeTokens).toEqual(new Set(["PRIVATE-ACCESS-TOKEN", "PRIVATE-REFRESH-TOKEN"]));
    }, { onAuthorizationUrl: approve });
    expect(activeTokens.size).toBe(0);
    const hints = requests.filter((request) => request.path.startsWith("/oauth/revoke"))
      .map((request) => new URLSearchParams(request.body).get("token_type_hint"));
    expect(hints).toEqual(["refresh_token", "access_token"]);
  });

  it("revokes the access token when no refresh token was issued", async () => {
    omitRefreshToken = true;
    await withMcpKeyAuthorization(new URL(`${origin}/mcp`), async () => undefined, { onAuthorizationUrl: approve });
    expect(revoked).toEqual(["PRIVATE-ACCESS-TOKEN"]);
    expect(activeTokens.size).toBe(0);
  });

  it.each(["PRIVATE-ACCESS-TOKEN", "PRIVATE-REFRESH-TOKEN"])("attempts both cleanups when revoking %s fails", async (failedToken) => {
    revokeFailureFor = failedToken;
    await expect(withMcpKeyAuthorization(new URL(`${origin}/mcp`), async () => undefined, { onAuthorizationUrl: approve }))
      .rejects.toThrow(/temporary CLI connection could not be revoked/);
    expect(revoked).toEqual(["PRIVATE-REFRESH-TOKEN", "PRIVATE-ACCESS-TOKEN"]);
    expect(activeTokens).toEqual(new Set([failedToken]));
  });

  it("reports failed revocation without claiming the temporary connection was removed", async () => {
    revokeError = true;
    await expect(withMcpKeyAuthorization(new URL(`${origin}/mcp`), async () => undefined, { onAuthorizationUrl: approve }))
      .rejects.toThrow(/temporary CLI connection could not be revoked/);
    expect(revoked).toEqual(["PRIVATE-REFRESH-TOKEN", "PRIVATE-ACCESS-TOKEN"]);
  });

  it("preserves operation recovery instructions even if OAuth cleanup also fails", async () => {
    revokeError = true;
    await expect(withMcpKeyAuthorization(new URL(`${origin}/mcp`), async () => {
      throw new OpperError("NETWORK_ERROR", "Outcome uncertain.", "Reuse the original request UUID.");
    }, { onAuthorizationUrl: approve })).rejects.toMatchObject({
      message: expect.stringContaining("temporary CLI connection could not be revoked"), hint: "Reuse the original request UUID.",
    });
  });
});
