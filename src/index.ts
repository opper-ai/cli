#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { OpperError, EXIT_CODES } from "./errors.js";
import { printError } from "./ui/print.js";
import { whoamiCommand } from "./commands/whoami.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import {
  skillsInstallCommand,
  skillsUpdateCommand,
  skillsListCommand,
} from "./commands/skills.js";
import {
  editorsListCommand,
  editorsOpenCodeCommand,
  editorsContinueCommand,
} from "./commands/editors.js";
import { setupCommand } from "./commands/setup.js";
import { agentsListCommand } from "./commands/agents.js";
import { launchCommand } from "./commands/launch.js";
import { callCommand } from "./commands/call.js";
import {
  modelsListCommand,
  modelsCreateCommand,
  modelsGetCommand,
  modelsDeleteCommand,
} from "./commands/models.js";
import {
  functionsListCommand,
  functionsGetCommand,
  functionsDeleteCommand,
} from "./commands/functions.js";
import {
  tracesListCommand,
  tracesGetCommand,
  tracesDeleteCommand,
} from "./commands/traces.js";
import {
  configAddCommand,
  configListCommand,
  configGetCommand,
  configRemoveCommand,
} from "./commands/config.js";
import {
  indexesListCommand,
  indexesGetCommand,
  indexesCreateCommand,
  indexesDeleteCommand,
  indexesQueryCommand,
  indexesAddCommand,
} from "./commands/indexes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
) as { version: string };

async function readStdinIfPiped(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

const program = new Command();

program
  .name("opper")
  .description("The official Opper CLI")
  .version(pkg.version, "-v, --version")
  .option("--key <slot>", "API key slot to use", "default")
  .option("--debug", "enable debug output", false)
  .option("--no-telemetry", "disable anonymous telemetry")
  .option("--no-color", "disable ANSI colors");

program.hook("preAction", () => {
  if (program.opts().color === false) {
    process.env.NO_COLOR = "1";
  }
});

program
  .command("version")
  .description("Print the CLI version")
  .action(() => {
    console.log(pkg.version);
  });

program
  .command("whoami")
  .description("Show the authenticated user for the active slot")
  .action(async () => {
    await whoamiCommand({ key: program.opts().key });
  });

program
  .command("login")
  .description("Authenticate with Opper via the OAuth device flow")
  .option("--force", "re-authenticate even if a key is already stored")
  .option("--base-url <url>", "override the Opper API base URL")
  .action(async (cmdOpts: { force?: boolean; baseUrl?: string }) => {
    await loginCommand({
      key: program.opts().key,
      ...(cmdOpts.baseUrl ? { baseUrl: cmdOpts.baseUrl } : {}),
      ...(cmdOpts.force ? { force: true } : {}),
    });
  });

program
  .command("logout")
  .description("Clear stored Opper credentials for a slot")
  .option("--all", "clear every slot", false)
  .option("--yes", "skip confirmation for --all", false)
  .action(async (cmdOpts: { all?: boolean; yes?: boolean }) => {
    await logoutCommand({
      key: program.opts().key,
      all: cmdOpts.all ?? false,
      ...(cmdOpts.yes ? { yes: true } : {}),
    });
  });

const skills = program.command("skills").description("Manage Opper skills");

skills
  .command("install")
  .description("Install Opper skills via `npx skills add opper-ai/opper-skills`")
  .action(skillsInstallCommand);

skills
  .command("update")
  .description("Update Opper skills to the latest version")
  .action(skillsUpdateCommand);

skills
  .command("list")
  .description("Show whether Opper skills are installed")
  .action(skillsListCommand);

const editors = program
  .command("editors")
  .description("Configure Opper in supported AI code editors");

editors
  .command("list")
  .description("List supported editors")
  .action(editorsListCommand);

editors
  .command("opencode")
  .description("Write the Opper provider block into OpenCode's config")
  .option("--global", "write to ~/.config/opencode/opencode.json", true)
  .option("--local", "write to ./opencode.json in the current directory")
  .option("--overwrite", "replace an existing Opper provider if present")
  .action(async (cmdOpts: { global?: boolean; local?: boolean; overwrite?: boolean }) => {
    await editorsOpenCodeCommand({
      location: cmdOpts.local ? "local" : "global",
      overwrite: cmdOpts.overwrite ?? false,
    });
  });

editors
  .command("continue")
  .description("Write Opper models into Continue.dev's config")
  .option("--global", "write to ~/.continue/config.yaml", true)
  .option("--local", "write to ./.continue/config.yaml")
  .option("--overwrite", "replace existing Opper models if present")
  .action(async (cmdOpts: { global?: boolean; local?: boolean; overwrite?: boolean }) => {
    await editorsContinueCommand({
      location: cmdOpts.local ? "local" : "global",
      overwrite: cmdOpts.overwrite ?? false,
      key: program.opts().key,
    });
  });

program
  .command("setup")
  .description("Run the interactive setup wizard")
  .action(async () => {
    await setupCommand({ key: program.opts().key });
  });

const agentsCmd = program
  .command("agents")
  .description("Manage supported AI agents");

agentsCmd
  .command("list")
  .description("List supported agents and whether each is installed")
  .action(agentsListCommand);

program
  .command("launch")
  .description("Launch an AI agent with its inference routed through Opper")
  .argument("<agent>", "agent name (e.g. hermes)")
  .option("--model <id>", "Opper model identifier", "anthropic/claude-opus-4.7")
  .option("--install", "install the agent if missing", false)
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (agentName: string, cmdOpts: { model?: string; install?: boolean }, cmd) => {
    const args = (cmd.args as string[]).slice(1);
    const code = await launchCommand({
      agent: agentName,
      key: program.opts().key,
      ...(cmdOpts.model ? { model: cmdOpts.model } : {}),
      ...(cmdOpts.install ? { install: true } : {}),
      passthrough: args,
    });
    process.exit(code);
  });

program
  .command("call")
  .description("Execute a function by name via the Opper v3 /call endpoint")
  .argument("<name>", "function name")
  .argument("<instructions>", "instructions / system prompt")
  .argument("[input]", "input (or piped via stdin)")
  .option("--model <id>", "model identifier (e.g. anthropic/claude-opus-4.7)")
  .option("--stream", "stream the response token-by-token", false)
  .action(async (
    name: string,
    instructions: string,
    input: string | undefined,
    cmdOpts: { model?: string; stream?: boolean },
  ) => {
    const resolvedInput = input ?? (await readStdinIfPiped());
    if (!resolvedInput) {
      throw new OpperError(
        "API_ERROR",
        "No input provided",
        "Pass input as the third positional argument, or pipe via stdin.",
      );
    }
    await callCommand({
      name,
      instructions,
      input: resolvedInput,
      key: program.opts().key,
      ...(cmdOpts.model ? { model: cmdOpts.model } : {}),
      ...(cmdOpts.stream ? { stream: true } : {}),
    });
  });

const modelsCmd = program
  .command("models")
  .description("Manage models");

modelsCmd
  .command("list")
  .description("List available models")
  .argument("[filter]", "optional substring filter on name or id")
  .action(async (filter: string | undefined) => {
    await modelsListCommand({
      key: program.opts().key,
      ...(filter ? { filter } : {}),
    });
  });

modelsCmd
  .command("create")
  .description("Register a custom model (LiteLLM-compatible)")
  .argument("<name>", "friendly name")
  .argument("<identifier>", "LiteLLM identifier (e.g. azure/gpt-4o)")
  .argument("<apiKey>", "API key for the upstream provider")
  .option("--extra <json>", "JSON provider-specific config (api_base, api_version, etc.)")
  .action(async (
    name: string,
    identifier: string,
    apiKey: string,
    cmdOpts: { extra?: string },
  ) => {
    await modelsCreateCommand({
      name,
      identifier,
      apiKey,
      key: program.opts().key,
      ...(cmdOpts.extra ? { extraJson: cmdOpts.extra } : {}),
    });
  });

modelsCmd
  .command("get")
  .description("Show details of a custom model")
  .argument("<name>", "custom model name")
  .action(async (name: string) => {
    await modelsGetCommand({ name, key: program.opts().key });
  });

modelsCmd
  .command("delete")
  .description("Delete a custom model by name")
  .argument("<name>", "custom model name")
  .action(async (name: string) => {
    await modelsDeleteCommand({ name, key: program.opts().key });
  });

const functionsCmd = program
  .command("functions")
  .description("Manage Opper functions");

functionsCmd
  .command("list")
  .description("List functions")
  .argument("[filter]", "optional substring filter on name")
  .action(async (filter: string | undefined) => {
    await functionsListCommand({
      key: program.opts().key,
      ...(filter ? { filter } : {}),
    });
  });

functionsCmd
  .command("get")
  .description("Show details of a function")
  .argument("<name>", "function name")
  .action(async (name: string) => {
    await functionsGetCommand({ name, key: program.opts().key });
  });

functionsCmd
  .command("delete")
  .description("Delete a function")
  .argument("<name>", "function name")
  .action(async (name: string) => {
    await functionsDeleteCommand({ name, key: program.opts().key });
  });

const tracesCmd = program
  .command("traces")
  .description("View and manage traces");

tracesCmd
  .command("list")
  .description("List traces")
  .option("--limit <n>", "max items to return", (v) => parseInt(v, 10))
  .option("--offset <n>", "items to skip", (v) => parseInt(v, 10))
  .option("--name <substring>", "filter by trace name substring")
  .action(async (cmdOpts: { limit?: number; offset?: number; name?: string }) => {
    await tracesListCommand({
      key: program.opts().key,
      ...(cmdOpts.limit !== undefined ? { limit: cmdOpts.limit } : {}),
      ...(cmdOpts.offset !== undefined ? { offset: cmdOpts.offset } : {}),
      ...(cmdOpts.name ? { name: cmdOpts.name } : {}),
    });
  });

tracesCmd
  .command("get")
  .description("Show a trace and its spans")
  .argument("<id>", "trace id")
  .action(async (id: string) => {
    await tracesGetCommand({ id, key: program.opts().key });
  });

tracesCmd
  .command("delete")
  .description("Delete a trace")
  .argument("<id>", "trace id")
  .action(async (id: string) => {
    await tracesDeleteCommand({ id, key: program.opts().key });
  });

const configCmd = program
  .command("config")
  .description("Manage stored API keys");

configCmd
  .command("add")
  .description("Manually store an API key for a slot")
  .argument("<name>", "slot name")
  .argument("<apiKey>", "Opper API key")
  .option("--base-url <url>", "custom Opper base URL for this slot")
  .action(async (
    name: string,
    apiKey: string,
    cmdOpts: { baseUrl?: string },
  ) => {
    await configAddCommand({
      name,
      apiKey,
      ...(cmdOpts.baseUrl ? { baseUrl: cmdOpts.baseUrl } : {}),
    });
  });

configCmd
  .command("list")
  .description("List configured slots")
  .action(configListCommand);

configCmd
  .command("get")
  .description("Print the API key for a slot (raw, for scripts)")
  .argument("<name>", "slot name")
  .action(async (name: string) => {
    await configGetCommand({ name });
  });

configCmd
  .command("remove")
  .description("Delete a stored slot")
  .argument("<name>", "slot name")
  .action(async (name: string) => {
    await configRemoveCommand({ name });
  });

const indexesCmd = program
  .command("indexes")
  .description("Manage knowledge base indexes");

indexesCmd
  .command("list")
  .description("List indexes")
  .option("--limit <n>", "max items", (v) => parseInt(v, 10))
  .option("--offset <n>", "items to skip", (v) => parseInt(v, 10))
  .action(async (cmdOpts: { limit?: number; offset?: number }) => {
    await indexesListCommand({
      key: program.opts().key,
      ...(cmdOpts.limit !== undefined ? { limit: cmdOpts.limit } : {}),
      ...(cmdOpts.offset !== undefined ? { offset: cmdOpts.offset } : {}),
    });
  });

indexesCmd
  .command("get")
  .description("Show details of an index")
  .argument("<name>", "index name")
  .action(async (name: string) => {
    await indexesGetCommand({ name, key: program.opts().key });
  });

indexesCmd
  .command("create")
  .description("Create a new index")
  .argument("<name>", "index name")
  .option("--embedding-model <id>", "override the embedding model")
  .action(async (name: string, cmdOpts: { embeddingModel?: string }) => {
    await indexesCreateCommand({
      name,
      key: program.opts().key,
      ...(cmdOpts.embeddingModel ? { embeddingModel: cmdOpts.embeddingModel } : {}),
    });
  });

indexesCmd
  .command("delete")
  .description("Delete an index by name")
  .argument("<name>", "index name")
  .action(async (name: string) => {
    await indexesDeleteCommand({ name, key: program.opts().key });
  });

indexesCmd
  .command("query")
  .description("Query an index")
  .argument("<name>", "index name")
  .argument("<query>", "query string")
  .option("--top-k <n>", "number of results", (v) => parseInt(v, 10))
  .option("--filters <json>", "JSON-encoded filter object")
  .action(async (
    name: string,
    query: string,
    cmdOpts: { topK?: number; filters?: string },
  ) => {
    await indexesQueryCommand({
      name,
      query,
      key: program.opts().key,
      ...(cmdOpts.topK !== undefined ? { topK: cmdOpts.topK } : {}),
      ...(cmdOpts.filters ? { filtersJson: cmdOpts.filters } : {}),
    });
  });

indexesCmd
  .command("add")
  .description("Add a document to an index")
  .argument("<name>", "index name")
  .argument("<content>", "document content (or - to read from stdin)")
  .option("--key <id>", "document key / id")
  .option("--metadata <json>", "JSON-encoded metadata object")
  .action(async (
    name: string,
    content: string,
    cmdOpts: { key?: string; metadata?: string },
  ) => {
    let resolvedContent = content;
    if (content === "-") {
      resolvedContent = (await readStdinIfPiped()) ?? "";
      if (!resolvedContent) {
        throw new OpperError(
          "API_ERROR",
          "No content on stdin",
          "Pipe content into the CLI or pass it as a positional argument.",
        );
      }
    }
    await indexesAddCommand({
      name,
      content: resolvedContent,
      key: program.opts().key,
      ...(cmdOpts.key ? { docKey: cmdOpts.key } : {}),
      ...(cmdOpts.metadata ? { metadataJson: cmdOpts.metadata } : {}),
    });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  printError(err);
  const code = err instanceof OpperError ? EXIT_CODES[err.code] : 1;
  process.exit(code);
});
