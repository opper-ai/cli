import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/client";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { OpperError } from "../errors.js";
import { openBrowser } from "../util/open-browser.js";
import { opperHome } from "./paths.js";

export const KEY_SETUP_SCOPES = "projects:read apikeys:write";
type ClientInfo = NonNullable<Awaited<ReturnType<OAuthClientProvider["clientInformation"]>>>;
type Tokens = Parameters<OAuthClientProvider["saveTokens"]>[0];
const registrationSchema = z.object({
  client_id: z.string().min(1).max(200), issuer: z.string().url(),
  redirect_uris: z.array(z.string().url()).length(1),
  token_endpoint_auth_method: z.literal("none"),
});
function revocationEndpoint(discovery: OAuthDiscoveryState | undefined): string | undefined {
  const metadata = discovery?.authorizationServerMetadata;
  return metadata && "revocation_endpoint" in metadata && typeof metadata.revocation_endpoint === "string"
    ? metadata.revocation_endpoint : undefined;
}

export function validateMcpServerUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new OpperError("INVALID_ARGUMENT", "The MCP URL must be an absolute HTTPS or loopback HTTP URL."); }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.username || url.password || url.hash || url.search || !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) {
    throw new OpperError("INVALID_ARGUMENT", "The MCP URL must use HTTPS or loopback HTTP, without credentials, a query, or a fragment.");
  }
  return url;
}

export interface KeyAuthorizationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  resetClient?: boolean;
  /** An interrupted create must retain its original idempotency namespace. */
  preserveClientRegistration?: boolean;
  /** Browser handoff injection for native-flow tests; never receives tokens. */
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
}

/** SDK-owned OAuth with only public client registration persisted between runs. */
export async function withMcpKeyAuthorization<T>(
  serverUrl: URL,
  operation: (accessToken: string) => Promise<T>,
  options: KeyAuthorizationOptions = {},
): Promise<T> {
  if (options.resetClient && options.preserveClientRegistration) {
    throw new OpperError("INVALID_ARGUMENT", "Cannot reset the client while recovering an interrupted key create.");
  }
  const state = randomBytes(32).toString("base64url");
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, options.timeoutMs ?? 300_000);
  let tokens: Tokens | undefined;
  let clientInfo: ClientInfo | undefined;
  let registrationPath: string | undefined;
  let resetApplied = false;
  let discovery: OAuthDiscoveryState | undefined;
  let verifier = "";
  let requestedScope = KEY_SETUP_SCOPES;
  let callbackComplete = false;
  let resolveCallback!: (value: { code: string; iss?: string }) => void;
  let rejectCallback!: (reason: OpperError) => void;
  const callback = new Promise<{ code: string; iss?: string }>((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
  // The callback may finish while the SDK is completing its redirect hook.
  void callback.catch(() => {});
  const callbackAbort = () => rejectCallback(new OpperError("AUTH_REQUIRED", "Browser authorization was cancelled or timed out. No key was installed.",
    options.preserveClientRegistration
      ? "Keep the original client registration and --idempotency-key when retrying recovery."
      : "If the browser reports invalid_client after a server reset, retry with --reset-client. Use that option only for a fresh key create, never an uncertain earlier operation."));
  controller.signal.addEventListener("abort", callbackAbort, { once: true });
  let redirectUrl = "";
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    let url: URL;
    try { url = new URL(request.url ?? "/", redirectUrl || "http://127.0.0.1"); }
    catch { response.writeHead(400).end("Invalid callback URL."); return; }
    const receivedState = url.searchParams.get("state") ?? "";
    const expected = Buffer.from(state);
    const received = Buffer.from(receivedState);
    const validState = received.length === expected.length && timingSafeEqual(received, expected);
    const duplicate = [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1);
    if (request.method !== "GET" || url.pathname !== "/mcp/key-callback" || !validState || duplicate || callbackComplete) {
      response.writeHead(400).end("This callback is not valid. Continue the original browser authorization.");
      return;
    }
    if (url.searchParams.has("error")) {
      callbackComplete = true;
      response.writeHead(200).end("Authorization was not approved. Return to the terminal.");
      rejectCallback(new OpperError("AUTH_REQUIRED", "Authorization was not approved. No key was installed."));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code || code.length > 2048) { response.writeHead(400).end("Missing authorization code."); return; }
    callbackComplete = true;
    const iss = url.searchParams.get("iss");
    response.writeHead(200).end("Authorization received. Return to the terminal to finish private key setup.");
    resolveCallback({ code, ...(iss ? { iss } : {}) });
  });

  const secureFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    validateMcpServerUrl(new URL(url.pathname, url.origin).href);
    if (url.username || url.password || url.hash) throw new Error("Unsafe OAuth destination");
    return fetch(input, { ...init, redirect: "error", signal: AbortSignal.any([
      controller.signal, AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : []),
    ]) });
  };
  const clientPath = (issuer: string) => join(opperHome(), "mcp-clients", `${createHash("sha256").update(`${serverUrl.href}\n${issuer}`).digest("hex")}.json`);
  const provider: OAuthClientProvider = {
    get redirectUrl() { return redirectUrl; },
    get clientMetadata() { return {
      client_name: "Opper CLI private key setup", redirect_uris: [redirectUrl],
      token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      scope: KEY_SETUP_SCOPES,
    }; },
    state: () => state,
    async clientInformation(context) {
      if (clientInfo) return clientInfo;
      if (!context) return undefined;
      try {
        const path = clientPath(context.issuer);
        registrationPath = path;
        if (options.resetClient && !resetApplied) {
          await rm(path, { force: true });
          resetApplied = true;
        }
        if (!(await lstat(path)).isFile()) throw new Error("Expected a registration file");
        const saved = registrationSchema.parse(JSON.parse(await readFile(path, "utf8")));
        if (saved.issuer !== context.issuer) throw new Error("Issuer mismatch");
        clientInfo = saved;
        return clientInfo;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          if (options.preserveClientRegistration) {
            throw new OpperError("AUTH_REQUIRED", "The original client registration is missing; the interrupted create cannot be safely recovered with a new client.",
              "Restore the original registration or reconcile the earlier key in Opper before starting a fresh create.");
          }
          return undefined;
        }
        throw new Error("Stored client registration could not be read");
      }
    },
    async saveClientInformation(information, context) {
      if (!context || information.client_secret) throw new Error("Expected a public client registration");
      const saved = registrationSchema.parse({ client_id: information.client_id, issuer: context.issuer,
        redirect_uris: [redirectUrl], token_endpoint_auth_method: "none" });
      await mkdir(join(opperHome(), "mcp-clients"), { recursive: true, mode: 0o700 });
      // Concurrent first registrations must never replace the winning identity.
      const path = clientPath(context.issuer);
      registrationPath = path;
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(saved) + "\n"); await handle.sync(); }
        finally { await handle.close(); }
        await link(temporary, path);
      } finally { await rm(temporary, { force: true }); }
      clientInfo = saved;
    },
    async invalidateCredentials(scope) {
      if (scope === "client" || scope === "all") {
        if (options.preserveClientRegistration) {
          throw new OpperError("AUTH_REQUIRED", "Recovery cannot continue with this invalid client; the original client registration was preserved.",
            "Restore access to the original client or reconcile the earlier key in Opper before starting a fresh create.");
        }
        if (registrationPath && clientInfo) {
          // Only discard the exact rejected identity; another run may have reset it.
          try {
            const saved = registrationSchema.parse(JSON.parse(await readFile(registrationPath, "utf8")));
            if (saved.client_id === clientInfo.client_id) await rm(registrationPath, { force: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        clientInfo = undefined;
        // The old code belongs to the old client. Require a new browser flow.
        throw new OpperError("AUTH_REQUIRED", "The rejected OAuth client registration was removed. Start key setup again to register a new client and approve fresh access.");
      }
      if (scope === "tokens") tokens = undefined;
      if (scope === "verifier") verifier = "";
      if (scope === "discovery") discovery = undefined;
    },
    tokens: () => tokens,
    saveTokens(value) { tokens = value; },
    saveCodeVerifier(value) { verifier = value; },
    codeVerifier: () => verifier,
    saveDiscoveryState(value) {
      if (!revocationEndpoint(value)) throw new Error("Missing revocation endpoint");
      discovery = value;
    },
    discoveryState: () => discovery,
    async redirectToAuthorization(url) {
      requestedScope = url.searchParams.get("scope") ?? KEY_SETUP_SCOPES;
      validateMcpServerUrl(new URL(url.pathname, url.origin).href);
      if (url.username || url.password || url.hash) throw new Error("Unsafe authorization destination");
      if (options.onAuthorizationUrl) await options.onAuthorizationUrl(url);
      else {
        process.stderr.write(`Approve this project's read access and API key creation in Opper.\nOpening your browser; if needed, open this URL directly:\n${url.href}\n`);
        openBrowser(url.href);
      }
    },
  };
  let result: T | undefined;
  let failure: OpperError | undefined;
  let runningOperation = false;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No callback address");
    redirectUrl = `http://127.0.0.1:${address.port}/mcp/key-callback`;
    const first = await auth(provider, { serverUrl, scope: KEY_SETUP_SCOPES, fetchFn: secureFetch });
    if (first !== "REDIRECT") throw new Error("Expected fresh browser consent");
    const response = await callback;
    await auth(provider, { serverUrl, scope: KEY_SETUP_SCOPES, authorizationCode: response.code, ...(response.iss ? { iss: response.iss } : {}), fetchFn: secureFetch });
    // RFC 6749 permits omission when the grant equals the requested scopes.
    const granted = new Set((tokens?.scope ?? requestedScope).split(/\s+/).filter(Boolean));
    if (!tokens?.access_token || granted.size !== 2 || !granted.has("projects:read") || !granted.has("apikeys:write")) {
      throw new OpperError("AUTH_REQUIRED", "Key setup needs project read access and API key creation permission. Start again and explicitly select both in Opper.");
    }
    runningOperation = true;
    result = await operation(tokens.access_token);
  } catch (error) {
    failure = error instanceof OpperError ? error : new OpperError("AUTH_REQUIRED", runningOperation
      ? "The private key setup could not be completed." : "Browser authorization could not be completed. Start again from the CLI.");
  } finally {
    if (tokens?.access_token) {
      try {
        const endpoint = revocationEndpoint(discovery);
        if (!endpoint || !clientInfo) throw new Error("Missing revocation metadata");
        validateMcpServerUrl(endpoint);
        const response = await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: tokens.refresh_token ?? tokens.access_token, client_id: clientInfo.client_id }),
        });
        if (!response.ok) throw new Error("Revocation failed");
      } catch {
        failure = new OpperError("API_ERROR", `${failure ? failure.message + " " : ""}The temporary CLI connection could not be revoked. Disconnect 'Opper CLI private key setup' in Opper's Agent connections.`, failure?.hint);
      }
    }
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", callbackAbort);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    tokens = undefined;
    verifier = "";
  }
  if (failure) throw failure;
  return result as T;
}
