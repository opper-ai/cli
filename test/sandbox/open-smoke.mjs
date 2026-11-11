// Run after npm run build: node test/sandbox/open-smoke.mjs all urls
// Real SRT check of the open default ("all") and --log-urls ("urls"): fetches
// example.com/.net without credentials and expects a deny rule on
// example.org to hold. Prints the status codes and the logged events.
import { mkdtemp, mkdir, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSrt } from "../../dist/sandbox/srt.js";
import { sandboxEnvironment } from "../../dist/sandbox/launch.js";
import { changePolicy } from "../../scripts/sandbox-policy/policy.mjs";
const root = await realpath(await mkdtemp(join(tmpdir(), "dune-open-")));
const project = join(root, "project"),
  policy = join(root, "policy");
await mkdir(project);
await mkdir(policy);
changePolicy(0, "example.org", "deny", policy);
const log = [];
try {
  const env = sandboxEnvironment(project, project);
  env.NODE_USE_ENV_PROXY = "1";
  const code = await runSrt(
    [
      "/bin/sh",
      "-c",
      `for u in "https://example.com/some/path?secret=1" https://example.org/ http://example.net/plain; do /usr/bin/curl -sS -o /dev/null -w "%{http_code} $u\\n" --max-time 15 "$u" >> results 2>&1; done; ${process.execPath} -e 'fetch("https://example.com/from-node").then(r=>console.log("node",r.status),e=>console.log("node failed",e.cause?.code??e.message))' >> results 2>&1`,
    ],
    {
      network: { allowedDomains: ["example.com"], deniedDomains: [] },
      filesystem: { allowWrite: [project], denyRead: [], denyWrite: [policy] },
    },
    env,
    project,
    (kind, detail) => {
      if (kind !== "POLICY") log.push(`${kind} ${detail}`);
    },
    policy,
    {
      allowAll: process.argv.includes("all"),
      urls: process.argv.includes("urls"),
    },
  );
  console.log({ code });
  console.log(await readFile(join(project, "results"), "utf8"));
  console.log(log.join("\n"));
} finally {
  await rm(root, { recursive: true, force: true });
}
