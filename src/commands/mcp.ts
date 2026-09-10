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
  if (result.backupPath) console.log(`Previous config retained at ${result.backupPath}`);
  if (result.mcpScopes !== undefined) console.log(`Requested permissions: ${result.mcpScopes}`);
  if (result.mcpEnabled === false) {
    console.log(`The ${result.mcpName} connection is disabled. Enable it in OpenCode when you want to connect.`);
  }
  if (result.mcpOAuthEnabled === false) {
    console.log(`OAuth is disabled for ${result.mcpName}. Remove its oauth: false setting from the effective OpenCode config to enable browser consent, then reopen OpenCode.`);
    return;
  }
  if (result.mcpEnabled === false) return;
  console.log(`Reopen OpenCode to load the server, then connect ${result.mcpName} and choose permissions in Opper in your browser.`);
  const name = result.mcpName ?? "opper";
  // Use the native picker when a name needs shell quoting or could instead
  // select an option/subcommand. The fallback contains no config-controlled text.
  const directName = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name) && name !== "list" && name !== "ls";
  console.log(`If your client needs manual authentication, run: opencode mcp auth${directName ? ` ${name}` : ""}`);
  if (!directName) console.log("Select the connection named above from OpenCode's server picker.");
}
