import { createServer } from "node:http";
import { mkdtemp, mkdir, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSrt } from "../../dist/sandbox/srt.js";
import { sandboxEnvironment } from "../../dist/sandbox/launch.js";
import { changePolicy } from "../../scripts/sandbox-policy/policy.mjs";
const root = await realpath(await mkdtemp(join(tmpdir(), "dune-live-policy-")));
const project = join(root, "project"),
  policy = join(root, "policy");
await mkdir(project);
await mkdir(policy);
const server = createServer((req, res) => res.end("ok"));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const target = `http://127.0.0.1:${server.address().port}/`;
const timers = [];
try {
  timers.push(
    setTimeout(() => changePolicy(0, "127.0.0.1", "deny", policy), 3500),
  );
  timers.push(
    setTimeout(() => changePolicy(1, "127.0.0.1", "allow", policy), 7500),
  );
  const code = await runSrt(
    [
      "/bin/sh",
      "-c",
      `i=0; while [ "$i" -lt 11 ]; do /usr/bin/curl --noproxy '' -sS -o /dev/null -w "%{http_code}\\n" --max-time 2 ${target} >> results; i=$((i+1)); sleep 1; done`,
    ],
    {
      network: { allowedDomains: ["127.0.0.1"], deniedDomains: [] },
      filesystem: { allowWrite: [project], denyRead: [], denyWrite: [policy] },
    },
    sandboxEnvironment(project, project),
    project,
    (kind, detail) => {
      if (kind === "POLICY") console.log(kind, detail);
    },
    policy,
  );
  const results = await readFile(join(project, "results"), "utf8");
  console.log({ code, results });
  if (!/200\n(?:200\n)*403\n(?:403\n)*200\n/.test(results))
    throw new Error("Expected allowed and denied connections");
} finally {
  server.close();
  timers.forEach(clearTimeout);
  await rm(root, { recursive: true, force: true });
}
