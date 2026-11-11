import { keysCreateCommand, type KeysCreateOptions } from "../commands/keys.js";
import type { RegisterFn } from "./types.js";

const register: RegisterFn = (program, ctx) => {
  program.command("keys").description("Create runtime keys through private browser authorization")
    .command("create").description("Create a project key into a new private env file; never print its secret")
    .requiredOption("--project <uuid>", "exact project UUID")
    .requiredOption("--name <name>", "runtime key name")
    .requiredOption("--output <path>", "new env file (0600); parent directory must exist")
    .option("--mcp-url <url>", "MCP server URL (default: selected deployment)")
    .option("--idempotency-key <uuid>", "reuse only to recover the same interrupted create operation")
    .option("--reset-client", "replace this server's cached OAuth registration for a fresh create; cannot be used with --idempotency-key")
    .action(async (options: KeysCreateOptions) => keysCreateCommand({ ...options, key: ctx.key() }));
};
export default register;
