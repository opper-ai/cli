import { randomUUID } from "node:crypto";
import { link, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { withMcpKeyAuthorization, validateMcpServerUrl } from "../auth/mcp-key-flow.js";
import { OPPER_HOST } from "../config/endpoints.js";
import { OpperError } from "../errors.js";

export interface KeysCreateOptions {
  project: string;
  name: string;
  output: string;
  mcpUrl?: string;
  idempotencyKey?: string;
}
const keySchema = z.object({ data: z.object({ id: z.number().int().positive(), key: z.string().optional() }) });

export async function keysCreateCommand(options: KeysCreateOptions): Promise<void> {
  const project = z.string().uuid().safeParse(options.project);
  const requestId = z.string().uuid().safeParse(options.idempotencyKey ?? randomUUID());
  if (!project.success || !requestId.success) throw new OpperError("INVALID_ARGUMENT", "Project and idempotency identifiers must be UUIDs.");
  if (!options.name.trim() || options.name.length > 200 || /[\x00-\x1f\x7f]/.test(options.name)) {
    throw new OpperError("INVALID_ARGUMENT", "The key name must contain 1–200 characters without control characters.");
  }
  if (!options.output) throw new OpperError("INVALID_ARGUMENT", "Choose a new output file for the private runtime key.");
  const mcpUrl = validateMcpServerUrl(options.mcpUrl ?? `${OPPER_HOST}/mcp`);
  const requestedPath = resolve(options.output);
  let output: string;
  try { output = join(await realpath(dirname(requestedPath)), basename(requestedPath)); }
  catch { throw new OpperError("INVALID_ARGUMENT", "The output directory must already exist and be accessible."); }
  try {
    await lstat(output);
    throw new OpperError("INVALID_ARGUMENT", "The output file already exists. Choose a new path; existing files are never overwritten.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let temporary: string;
  try { temporary = await mkdtemp(join(dirname(output), ".opper-key-")); }
  catch { throw new OpperError("INVALID_ARGUMENT", "The output directory is not writable."); }
  const signal = new AbortController();
  const cancel = () => signal.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    await withMcpKeyAuthorization(mcpUrl, async (token) => {
      const projectPath = `/user/v1/projects/${project.data}`;
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const request = (path: string, init: RequestInit = {}, cleanup = false) => fetch(new URL(path, mcpUrl), {
        ...init, headers, redirect: "error",
        signal: cleanup ? AbortSignal.timeout(10_000) : AbortSignal.any([signal.signal, AbortSignal.timeout(15_000)]),
      });
      let target: Response;
      try { target = await request(projectPath); }
      catch { throw new OpperError("NETWORK_ERROR", "The project could not be checked. No key was created."); }
      if (!target.ok) throw new OpperError("API_ERROR", "The project is not available in the organization you approved. No key was created.");
      const body = JSON.stringify({ name: options.name, idempotency_key: requestId.data, return_secret: true });
      let response: Response | undefined;
      // A lost response may still have committed. Never change the operation ID.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await request(`${projectPath}/api-keys`, { method: "POST", body });
          if (response.status < 500) break;
        } catch { /* Retry the same operation once to resolve an uncertain create. */ }
        if (signal.signal.aborted) break;
      }
      if (!response || response.status >= 500) {
        throw new OpperError("NETWORK_ERROR", "The key creation outcome could not be confirmed.",
          `Retry this same project/name with --idempotency-key ${requestId.data}, the same MCP URL, and the same Opper account/organization. Do not start a different create operation.`);
      }
      if (response.status !== 200 && response.status !== 201) {
        throw new OpperError("API_ERROR", `Key creation was not completed (HTTP ${response.status}). No output file was installed.`);
      }
      let value: z.infer<typeof keySchema>;
      try { value = keySchema.parse(await response.json()); }
      catch { throw new OpperError("API_ERROR", "The key creation response was incomplete.", `Use the same --idempotency-key ${requestId.data} to resolve this operation.`); }
      const keyId = value.data.id;
      const revokeKey = async (): Promise<boolean> => {
        try { return (await request(`${projectPath}/api-keys/${keyId}`, { method: "DELETE" }, true)).status === 204; }
        catch { return false; }
      };
      if (signal.signal.aborted) {
        const revoked = await revokeKey();
        throw new OpperError("AUTH_REQUIRED", revoked
          ? "Key setup was cancelled. The new key was revoked and no file was installed."
          : `Key setup was cancelled, but key ${keyId} could not be revoked. Revoke that exact key in Opper.`);
      }
      if (!value.data.key || !/^op-[A-Z0-9]{20}$/.test(value.data.key)) {
        const revoked = await revokeKey();
        throw new OpperError("API_ERROR", revoked
          ? "The key's secret was not received. That key was revoked; run again to create a replacement."
          : `The key's secret was not received and key ${keyId} could not be revoked. Revoke that exact key in Opper before creating a replacement.`);
      }
      try {
        const handle = await open(join(temporary, "key.env"), "wx", 0o600);
        try { await handle.writeFile(`OPPER_API_KEY=${value.data.key}\n`); await handle.sync(); }
        finally { await handle.close(); }
        // link() installs atomically and refuses existing files and symlinks.
        await link(join(temporary, "key.env"), output);
      } catch {
        const revoked = await revokeKey();
        throw new OpperError("API_ERROR", revoked
          ? "The key could not be saved without replacing an existing file. The new key was revoked. Choose a writable, unused output path."
          : `The key could not be saved and key ${keyId} could not be revoked. Revoke that exact key in Opper before trying again.`);
      }
      // This whitelist is the entire stdout contract. Never print API objects.
      console.log(JSON.stringify({ id: keyId, name: options.name, project_uuid: project.data, output }));
    }, { signal: signal.signal });
  } catch (error) {
    if (error instanceof OpperError) throw error;
    throw new OpperError("API_ERROR", "The private key setup could not be completed.");
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    await rm(temporary, { recursive: true, force: true });
  }
}
