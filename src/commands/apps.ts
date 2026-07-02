import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { confirm, isCancel } from "@clack/prompts";
import { OpperApi } from "../api/client.js";
import { resolveApiContext } from "../api/resolve.js";
import { OpperError } from "../errors.js";
import { brand } from "../ui/colors.js";
import { printTable } from "../ui/table.js";
import { cloneRepo } from "../util/git-clone.js";
import { makeTarball } from "../util/tarball.js";

// Opper Apps — deploy agent source as a managed app (the deploy/Knative
// backend). The customer surface is task-api's /v3/apps/*; creation is
// CLI-only by design (the platform UI is a viewer).

interface AppResponse {
  id: string;
  name: string;
  description?: string;
  status: string;
  endpoint_url?: string;
  runtime?: string;
  config?: { cpu?: number; memory?: number; timeout?: number };
  created_at?: string;
  updated_at?: string;
}

interface ListResponse {
  data: AppResponse[];
}

function invokeUrl(baseUrl: string, name: string): string {
  return `${baseUrl.replace(/\/$/, "")}/v3/apps/${encodeURIComponent(name)}/run`;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Polls an app until the build reaches a terminal state. "running" is
// success; "failed"/"stopped"/"paused" are terminal failures that throw
// DEPLOY_FAILED (exit 9) so CI/CD can gate on a green deploy. Status names
// mirror the deploy service (internal/domain: pending|building|running|
// failed|stopped|paused).
async function waitForReady(api: OpperApi, name: string): Promise<AppResponse> {
  const INTERVAL_MS = 3000;
  const TIMEOUT_MS = 15 * 60 * 1000;
  const start = Date.now();
  let last = "";
  for (;;) {
    const a = await api.get<AppResponse>(
      `/v3/apps/${encodeURIComponent(name)}`,
    );
    if (a.status !== last) {
      // Progress to stderr so stdout stays clean for scripting.
      console.error(brand.dim(`  ${a.status}`));
      last = a.status;
    }
    if (a.status === "running") return a;
    if (["failed", "stopped", "paused"].includes(a.status)) {
      throw new OpperError(
        "DEPLOY_FAILED",
        `App ${name} did not come up (status: ${a.status})`,
        `Inspect the build log: opper apps logs ${name}`,
      );
    }
    if (Date.now() - start > TIMEOUT_MS) {
      throw new OpperError(
        "DEPLOY_FAILED",
        `Timed out after ${Math.round(TIMEOUT_MS / 60000)}m waiting for ${name} (last status: ${a.status})`,
        `Check progress with: opper apps get ${name}`,
      );
    }
    await sleep(INTERVAL_MS);
  }
}

// ---- list -----------------------------------------------------------------

export interface AppsListOptions {
  key: string;
}

export async function appsListCommand(opts: AppsListOptions): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const resp = await api.get<ListResponse>("/v3/apps");
  const apps = resp.data ?? [];
  if (apps.length === 0) {
    console.log(
      `No apps yet. Deploy one with ${brand.bold("opper apps create --name my-agent --dir .")}`,
    );
    return;
  }
  const rows = apps.map((a) => [
    a.name,
    a.status,
    a.runtime ?? "",
    a.config ? `${a.config.cpu ?? "?"} vCPU / ${a.config.memory ?? "?"} MiB` : "",
    a.created_at ?? "",
  ]);
  printTable(["NAME", "STATUS", "RUNTIME", "RESOURCES", "CREATED"], rows);
}

// ---- get ------------------------------------------------------------------

export interface AppsGetOptions {
  name: string;
  key: string;
}

export async function appsGetCommand(opts: AppsGetOptions): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const a = await api.get<AppResponse>(
    `/v3/apps/${encodeURIComponent(opts.name)}`,
  );
  console.log(`${brand.bold("name:")}     ${a.name}`);
  if (a.description) console.log(`${brand.bold("about:")}    ${a.description}`);
  console.log(`${brand.bold("status:")}   ${a.status}`);
  if (a.runtime) console.log(`${brand.bold("runtime:")}  ${a.runtime}`);
  if (a.config) {
    console.log(
      `${brand.bold("size:")}     ${a.config.cpu} vCPU / ${a.config.memory} MiB / ${a.config.timeout}s timeout`,
    );
  }
  console.log(`${brand.bold("invoke:")}   POST ${invokeUrl(ctx.baseUrl, a.name)}`);
  if (a.created_at) console.log(`${brand.bold("created:")}  ${a.created_at}`);
  console.log(`${brand.bold("id:")}       ${a.id}`);
}

// ---- create / redeploy ------------------------------------------------------

export interface AppsCreateOptions {
  name?: string;
  dir?: string;
  repo?: string;
  ref?: string;
  config?: string;
  wait?: boolean;
  key: string;
}

/** Reads the app name from the source's opper.yaml (fly.io-style manifest). */
async function manifestName(dir: string): Promise<string | undefined> {
  for (const f of ["opper.yaml", "opper.yml"]) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    try {
      const m = parseYaml(await readFile(p, "utf8")) as { name?: unknown };
      if (typeof m?.name === "string" && m.name.trim()) return m.name.trim();
    } catch {
      // Malformed manifest — the deploy service will reject the build with
      // a precise error; don't duplicate validation here.
    }
  }
  return undefined;
}

async function sourceForm(dir: string, extra: Record<string, string>): Promise<FormData> {
  const { path, cleanup } = await makeTarball(dir);
  try {
    const bytes = await readFile(path);
    const form = new FormData();
    for (const [k, v] of Object.entries(extra)) form.set(k, v);
    form.set(
      "source",
      new Blob([new Uint8Array(bytes)], { type: "application/gzip" }),
      "src.tar.gz",
    );
    return form;
  } finally {
    await cleanup();
  }
}

export async function appsCreateCommand(opts: AppsCreateOptions): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);

  // Source: a local directory (default ".") or a git repo to shallow-clone.
  let srcDir = opts.dir ?? ".";
  let cleanupClone: (() => Promise<void>) | undefined;
  if (opts.repo) {
    const cloned = await cloneRepo(opts.repo, opts.ref);
    srcDir = cloned.dir;
    cleanupClone = cloned.cleanup;
    console.log(brand.dim(`cloned ${opts.repo}${opts.ref ? `@${opts.ref}` : ""}`));
  }

  try {
    // Name: explicit flag wins; otherwise the source's opper.yaml.
    const name = opts.name ?? (await manifestName(srcDir));
    if (!name) {
      throw new OpperError(
        "INVALID_ARGUMENT",
        "No app name given and the source has no opper.yaml with a name",
        "Pass --name, or add `name: my-agent` to the opper.yaml manifest.",
      );
    }

    const form = await sourceForm(srcDir, {
      name,
      ...(opts.config ? { config: opts.config } : {}),
    });
    const a = await api.postMultipart<AppResponse>("/v3/apps", form);
    console.log(`${brand.bold(a.name)} ${a.status}`);
    if (opts.wait) {
      const ready = await waitForReady(api, a.name);
      console.log(`${brand.bold(ready.name)} ${ready.status}`);
    } else {
      console.log(
        brand.dim(`build started — follow with: opper apps logs ${a.name}`),
      );
    }
    console.log(`${brand.bold("invoke:")} POST ${invokeUrl(ctx.baseUrl, a.name)}`);
  } finally {
    await cleanupClone?.();
  }
}

export interface AppsRedeployOptions {
  name: string;
  dir: string;
  wait?: boolean;
  key: string;
}

export async function appsRedeployCommand(
  opts: AppsRedeployOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const form = await sourceForm(opts.dir, {});
  const a = await api.postMultipart<AppResponse>(
    `/v3/apps/${encodeURIComponent(opts.name)}/redeploy`,
    form,
  );
  console.log(`${brand.bold(a.name)} ${a.status} ${brand.dim("(rebuilding)")}`);
  if (opts.wait) {
    const ready = await waitForReady(api, a.name);
    console.log(`${brand.bold(ready.name)} ${ready.status}`);
  }
}

// ---- delete -----------------------------------------------------------------

export interface AppsDeleteOptions {
  name: string;
  yes?: boolean;
  key: string;
}

export async function appsDeleteCommand(opts: AppsDeleteOptions): Promise<void> {
  if (!opts.yes) {
    // Destructive + irreversible: require an explicit yes. Non-interactive
    // callers (CI, pipes) must pass --yes rather than hang on a prompt.
    if (!process.stdin.isTTY) {
      throw new OpperError(
        "INVALID_ARGUMENT",
        `Refusing to delete "${opts.name}" without confirmation`,
        "Re-run with --yes to delete non-interactively.",
      );
    }
    const ok = await confirm({
      message: `Delete app "${opts.name}"? This stops and removes it.`,
      initialValue: false,
    });
    if (isCancel(ok) || ok !== true) {
      console.log("Cancelled — nothing deleted.");
      return;
    }
  }
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  await api.del(`/v3/apps/${encodeURIComponent(opts.name)}`);
  console.log(`${brand.bold(opts.name)} deleted`);
}

// ---- logs -------------------------------------------------------------------

export interface AppsLogsOptions {
  name: string;
  key: string;
}

export async function appsLogsCommand(opts: AppsLogsOptions): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  for await (const line of api.streamGet(
    `/v3/apps/${encodeURIComponent(opts.name)}/logs`,
  )) {
    console.log(line);
  }
}

// ---- secrets ------------------------------------------------------------------

export interface AppsSecretsListOptions {
  app: string;
  key: string;
}

export async function appsSecretsListCommand(
  opts: AppsSecretsListOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const resp = await api.get<{ data: Array<{ name: string; updated_at?: string }> }>(
    `/v3/apps/${encodeURIComponent(opts.app)}/secrets`,
  );
  const secrets = resp.data ?? [];
  if (secrets.length === 0) {
    console.log("No secrets set.");
    return;
  }
  printTable(
    ["NAME", "UPDATED"],
    secrets.map((s) => [s.name, s.updated_at ?? ""]),
  );
}

export interface AppsSecretsSetOptions {
  app: string;
  name: string;
  value?: string;
  fromStdin?: boolean;
  fromFile?: string;
  key: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function appsSecretsSetCommand(
  opts: AppsSecretsSetOptions,
): Promise<void> {
  // Resolve the value without ever requiring it on the command line, where
  // it would leak into shell history and `ps`. Precedence: positional arg →
  // --from-file (byte-exact) → --from-stdin (trailing newline trimmed so
  // `echo secret | …` doesn't store the \n).
  let value = opts.value;
  if (value === undefined && opts.fromFile !== undefined) {
    value = await readFile(opts.fromFile, "utf8");
  }
  if (value === undefined && opts.fromStdin) {
    value = (await readStdin()).replace(/\r?\n$/, "");
  }
  if (value === undefined) {
    throw new OpperError(
      "INVALID_ARGUMENT",
      "No secret value provided",
      "Pass it as an argument, or use --from-file <path> / --from-stdin.",
    );
  }
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  await api.post(`/v3/apps/${encodeURIComponent(opts.app)}/secrets`, {
    name: opts.name,
    value,
  });
  console.log(
    `${brand.bold(opts.name)} set on ${opts.app} ${brand.dim("(applies on next redeploy)")}`,
  );
}

export interface AppsSecretsDeleteOptions {
  app: string;
  name: string;
  key: string;
}

export async function appsSecretsDeleteCommand(
  opts: AppsSecretsDeleteOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  await api.del(
    `/v3/apps/${encodeURIComponent(opts.app)}/secrets/${encodeURIComponent(opts.name)}`,
  );
  console.log(
    `${brand.bold(opts.name)} deleted from ${opts.app} ${brand.dim("(applies on next redeploy)")}`,
  );
}
