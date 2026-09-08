import { configureOpenCode } from "../setup/opencode.js";
import { OpperError } from "../errors.js";
import { brand } from "../ui/colors.js";
import type { Location } from "../util/editor-paths.js";

export const MCP_CLIENTS = ["opencode"] as const;

export interface McpAddOptions {
  location: Location;
  url?: string;
  scopes?: string;
}

/** Configure account tools independently of the client's inference provider. */
export async function mcpAddCommand(client: string, opts: McpAddOptions): Promise<void> {
  if (client !== "opencode") {
    throw new OpperError("INVALID_ARGUMENT", `MCP setup is not supported for "${client}".`,
      `Supported clients: ${MCP_CLIENTS.join(", ")}.`);
  }
  const result = await configureOpenCode({
    location: opts.location,
    mcp: true,
    ...(opts.url !== undefined ? { mcpUrl: opts.url } : {}),
    ...(opts.scopes !== undefined ? { mcpScopes: opts.scopes } : {}),
  });
  console.log(brand.accent(result.wrote
    ? `✓ Configured Opper MCP (${result.mcpName}) in ${result.path}.`
    : `Opper MCP (${result.mcpName}) is already configured; existing settings were preserved.`));
  if (result.mcpScopes !== undefined) console.log(`Requested permissions: ${result.mcpScopes}`);
  if (result.mcpEnabled === false) {
    console.log(`The ${result.mcpName} connection is disabled. Enable it in OpenCode when you want to connect.`);
    return;
  }
  console.log(`Reopen OpenCode to load the server, then connect ${result.mcpName} and choose permissions in Opper in your browser.`);
  const name = result.mcpName ?? "opper";
  const shellName = /^[A-Za-z0-9_-]+$/.test(name) ? name : `'${name.replaceAll("'", "'\\''")}'`;
  console.log(`If your client needs manual authentication, run: opencode mcp auth ${shellName}`);
}
