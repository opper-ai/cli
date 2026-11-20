// Run after npm run build: node test/sandbox/log-smoke.mjs
// Real SRT check of what an allowlist session logs: an allowed and a blocked
// connection, the programs that ran, and a refused file read.
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSrt } from "../../dist/sandbox/srt.js";
import { sandboxEnvironment } from "../../dist/sandbox/launch.js";
const root = await realpath(await mkdtemp(join(tmpdir(), "dune-log-")));
const project = join(root, "project"),
  secret = join(root, "secret");
await mkdir(project);
await mkdir(secret);
await writeFile(join(secret, "key"), "hidden");
const log = [];
try {
  const env = sandboxEnvironment(project, project);
  const code = await runSrt(
    [
      "/bin/sh",
      "-c",
      `for u in https://example.com/ https://example.net/; do /usr/bin/curl -sS -o /dev/null -w "%{http_code} $u\\n" --max-time 15 "$u"; done; /bin/cat ${secret}/key; /bin/sleep 2`,
    ],
    {
      network: { allowedDomains: ["example.com"], deniedDomains: [] },
      filesystem: { allowWrite: [project], denyRead: [secret], denyWrite: [] },
    },
    env,
    project,
    (kind, detail) => log.push(`${kind} ${detail}`),
  );
  // Sandbox violations arrive from the system log a moment later.
  await new Promise((done) => setTimeout(done, 1500));
  console.log(`exit ${code}`);
  console.log(log.join("\n"));
} finally {
  await rm(root, { recursive: true, force: true });
}
