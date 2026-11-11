import { Argument, Option } from "commander";
import { MCP_CLIENTS, mcpAddCommand } from "../commands/mcp.js";
import type { RegisterFn } from "./types.js";

const register: RegisterFn = (program) => {
  const mcp = program.command("mcp")
    .description("Connect agents and editors to Opper account tools");

  mcp.command("add")
    .allowExcessArguments(false)
    .description("Add Opper MCP to a client without changing its inference settings")
    .addArgument(new Argument("<client>", "client to configure").choices([...MCP_CLIENTS]))
    .addOption(new Option("--global", "write to the user's client config (default)").conflicts("local"))
    .addOption(new Option("--local", "write to the current project's client config").conflicts("global"))
    .option("--url <url>", "MCP endpoint (default: selected deployment; loopback HTTP allowed)")
    .option("--scopes <scopes>", "advanced: limit browser permission choices to these space-separated OAuth scopes")
    .action(async (client: string, opts: { local?: boolean; url?: string; scopes?: string }) => {
      const key = program.opts().key as string | undefined;
      await mcpAddCommand(client, {
        location: opts.local ? "local" : "global",
        ...(key !== undefined ? { key } : {}),
        ...(opts.url !== undefined ? { url: opts.url } : {}),
        ...(opts.scopes !== undefined ? { scopes: opts.scopes } : {}),
      });
    });
};

export default register;
