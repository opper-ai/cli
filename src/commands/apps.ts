import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
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
  deploy_token?: string;
}

interface ListResponse {
  data: AppResponse[];
}

function invokeUrl(baseUrl: string, name: string): string {
  return `${baseUrl.replace(/\/$/, "")}/v3/apps/${encodeURIComponent(name)}/run`;
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
    if (a.deploy_token) {
      console.log(
        `${brand.bold("deploy token:")} ${a.deploy_token} ${brand.dim("(shown once — store it now)")}`,
      );
    }
    console.log(
      brand.dim(`build started — follow with: opper apps logs ${a.name}`),
    );
    console.log(`${brand.bold("invoke:")} POST ${invokeUrl(ctx.baseUrl, a.name)}`);
  } finally {
    await cleanupClone?.();
  }
}

export interface AppsRedeployOptions {
  name: string;
  dir: string;
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
}

// ---- delete -----------------------------------------------------------------

export interface AppsDeleteOptions {
  name: string;
  key: string;
}

export async function appsDeleteCommand(opts: AppsDeleteOptions): Promise<void> {
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

// ---- run --------------------------------------------------------------------

export interface AppsRunOptions {
  name: string;
  input: string;
  key: string;
}

export async function appsRunCommand(opts: AppsRunOptions): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const resp = await api.post<{ data?: unknown }>(
    `/v3/apps/${encodeURIComponent(opts.name)}/run`,
    { input: opts.input },
  );
  const out = resp.data;
  if (typeof out === "string") console.log(out);
  else console.log(JSON.stringify(resp, null, 2));
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
  value: string;
  key: string;
}

export async function appsSecretsSetCommand(
  opts: AppsSecretsSetOptions,
): Promise<void> {
  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  await api.post(`/v3/apps/${encodeURIComponent(opts.app)}/secrets`, {
    name: opts.name,
    value: opts.value,
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
