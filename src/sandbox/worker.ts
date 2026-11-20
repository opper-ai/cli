import { homedir } from "node:os";
import { toolHookArgs } from "./tool-hooks.js";
import { readFile } from "node:fs/promises";
import { getAdapter } from "../agents/registry.js";
import { isLaunchable } from "../agents/types.js";
import type { SandboxRequest } from "./launch.js";

// Load adapters in a separate process so home/config paths resolve inside the sandbox.
try {
  const request = JSON.parse(
    await readFile(process.argv[2]!, "utf8"),
  ) as SandboxRequest;
  const adapter = getAdapter(request.agent);
  if (!adapter || !isLaunchable(adapter))
    throw new Error("Unsupported sandbox agent");
  // The host forwards terminal signals to this worker's sandbox process group.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const)
    process.on(signal, () => {});
  const code = await adapter.spawn(
    await toolHookArgs(
      request.agent,
      request.args,
      homedir(),
      request.activityDirectory,
    ),
    request.routing,
    request.spawnOptions,
  );
  process.exitCode = code < 0 ? 1 : code;
} catch (error) {
  process.stderr.write(
    `Sandbox agent failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
}
