import { OpperError } from "../errors.js";
import { callCommand } from "../commands/call.js";
import {
  modelsListCommand,
  modelsCreateCommand,
  modelsGetCommand,
  modelsDeleteCommand,
} from "../commands/models.js";
import {
  functionsListCommand,
  functionsGetCommand,
  functionsDeleteCommand,
} from "../commands/functions.js";
import {
  tracesListCommand,
  tracesGetCommand,
  tracesDeleteCommand,
} from "../commands/traces.js";
import {
  indexesListCommand,
  indexesGetCommand,
  indexesCreateCommand,
  indexesDeleteCommand,
  indexesQueryCommand,
  indexesAddCommand,
} from "../commands/indexes.js";
import { usageListCommand } from "../commands/usage.js";
import { imageGenerateCommand } from "../commands/image.js";
import type { RegisterFn } from "./types.js";

async function readStdinIfPiped(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

const register: RegisterFn = (program, ctx) => {
  // ---- call --------------------------------------------------------------
  program
    .command("call")
    .description("Execute a function by name via the Opper v3 /call endpoint")
    .argument("<name>", "function name")
    .argument("<instructions>", "instructions / system prompt")
    .argument("[input]", "input (or piped via stdin)")
    .option("--model <id>", "model identifier (e.g. claude-opus-4-7)")
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
        key: ctx.key(),
        ...(cmdOpts.model ? { model: cmdOpts.model } : {}),
        ...(cmdOpts.stream ? { stream: true } : {}),
      });
    });

  // ---- models ------------------------------------------------------------
  const models = program.command("models").description("Manage models");

  models
    .command("list")
    .description("List available models")
    .argument("[filter]", "optional substring filter on name or id")
    .action(async (filter: string | undefined) => {
      await modelsListCommand({
        key: ctx.key(),
        ...(filter ? { filter } : {}),
      });
    });

  models
    .command("create")
    .description("Register a custom model")
    .argument("<name>", "friendly name")
    .argument("<identifier>", "model identifier (e.g. azure/gpt-4o)")
    .argument("<apiKey>", "API key for the upstream provider")
    .option("--extra <json>", "JSON provider-specific config")
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
        key: ctx.key(),
        ...(cmdOpts.extra ? { extraJson: cmdOpts.extra } : {}),
      });
    });

  models
    .command("get")
    .description("Show details of a custom model")
    .argument("<name>", "custom model name")
    .action(async (name: string) => {
      await modelsGetCommand({ name, key: ctx.key() });
    });

  models
    .command("delete")
    .description("Delete a custom model by name")
    .argument("<name>", "custom model name")
    .action(async (name: string) => {
      await modelsDeleteCommand({ name, key: ctx.key() });
    });

  // ---- functions ---------------------------------------------------------
  const functionsCmd = program
    .command("functions")
    .description("Manage Opper functions");

  functionsCmd
    .command("list")
    .description("List functions")
    .argument("[filter]", "optional substring filter on name")
    .action(async (filter: string | undefined) => {
      await functionsListCommand({
        key: ctx.key(),
        ...(filter ? { filter } : {}),
      });
    });

  functionsCmd
    .command("get")
    .description("Show details of a function")
    .argument("<name>", "function name")
    .action(async (name: string) => {
      await functionsGetCommand({ name, key: ctx.key() });
    });

  functionsCmd
    .command("delete")
    .description("Delete a function")
    .argument("<name>", "function name")
    .action(async (name: string) => {
      await functionsDeleteCommand({ name, key: ctx.key() });
    });

  // ---- traces ------------------------------------------------------------
  const traces = program
    .command("traces")
    .description("View and manage traces");

  traces
    .command("list")
    .description("List traces")
    .option("--limit <n>", "max items to return", (v) => parseInt(v, 10))
    .option("--offset <n>", "items to skip", (v) => parseInt(v, 10))
    .option("--name <substring>", "filter by trace name substring")
    .action(async (cmdOpts: { limit?: number; offset?: number; name?: string }) => {
      await tracesListCommand({
        key: ctx.key(),
        ...(cmdOpts.limit !== undefined ? { limit: cmdOpts.limit } : {}),
        ...(cmdOpts.offset !== undefined ? { offset: cmdOpts.offset } : {}),
        ...(cmdOpts.name ? { name: cmdOpts.name } : {}),
      });
    });

  traces
    .command("get")
    .description("Show a trace and its spans")
    .argument("<id>", "trace id")
    .action(async (id: string) => {
      await tracesGetCommand({ id, key: ctx.key() });
    });

  traces
    .command("delete")
    .description("Delete a trace")
    .argument("<id>", "trace id")
    .action(async (id: string) => {
      await tracesDeleteCommand({ id, key: ctx.key() });
    });

  // ---- indexes -----------------------------------------------------------
  const indexes = program
    .command("indexes")
    .description("Manage knowledge base indexes");

  indexes
    .command("list")
    .description("List indexes")
    .option("--limit <n>", "max items", (v) => parseInt(v, 10))
    .option("--offset <n>", "items to skip", (v) => parseInt(v, 10))
    .action(async (cmdOpts: { limit?: number; offset?: number }) => {
      await indexesListCommand({
        key: ctx.key(),
        ...(cmdOpts.limit !== undefined ? { limit: cmdOpts.limit } : {}),
        ...(cmdOpts.offset !== undefined ? { offset: cmdOpts.offset } : {}),
      });
    });

  indexes
    .command("get")
    .description("Show details of an index")
    .argument("<name>", "index name")
    .action(async (name: string) => {
      await indexesGetCommand({ name, key: ctx.key() });
    });

  indexes
    .command("create")
    .description("Create a new index")
    .argument("<name>", "index name")
    .option("--embedding-model <id>", "override the embedding model")
    .action(async (name: string, cmdOpts: { embeddingModel?: string }) => {
      await indexesCreateCommand({
        name,
        key: ctx.key(),
        ...(cmdOpts.embeddingModel ? { embeddingModel: cmdOpts.embeddingModel } : {}),
      });
    });

  indexes
    .command("delete")
    .description("Delete an index by name")
    .argument("<name>", "index name")
    .action(async (name: string) => {
      await indexesDeleteCommand({ name, key: ctx.key() });
    });

  indexes
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
        key: ctx.key(),
        ...(cmdOpts.topK !== undefined ? { topK: cmdOpts.topK } : {}),
        ...(cmdOpts.filters ? { filtersJson: cmdOpts.filters } : {}),
      });
    });

  indexes
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
        key: ctx.key(),
        ...(cmdOpts.key ? { docKey: cmdOpts.key } : {}),
        ...(cmdOpts.metadata ? { metadataJson: cmdOpts.metadata } : {}),
      });
    });

  // ---- usage -------------------------------------------------------------
  const usage = program
    .command("usage")
    .description("Analyse usage and costs");

  usage
    .command("list")
    .description("List usage rows grouped/bucketed by the given params")
    .option("--from-date <d>", "ISO date or RFC3339 start")
    .option("--to-date <d>", "ISO date or RFC3339 end")
    .option("--granularity <g>", "minute | hour | day | month | year")
    .option("--fields <csv>", "comma-separated extra fields (e.g. total_tokens)")
    .option("--group-by <csv>", "comma-separated group-by keys (e.g. model,customer_id)")
    .option("--out <format>", "text (default) | csv", "text")
    .action(async (cmdOpts: {
      fromDate?: string;
      toDate?: string;
      granularity?: string;
      fields?: string;
      groupBy?: string;
      out?: string;
    }) => {
      const out = cmdOpts.out === "csv" ? "csv" : "text";
      await usageListCommand({
        key: ctx.key(),
        ...(cmdOpts.fromDate ? { fromDate: cmdOpts.fromDate } : {}),
        ...(cmdOpts.toDate ? { toDate: cmdOpts.toDate } : {}),
        ...(cmdOpts.granularity ? { granularity: cmdOpts.granularity } : {}),
        ...(cmdOpts.fields ? { fields: cmdOpts.fields.split(",").map((s) => s.trim()) } : {}),
        ...(cmdOpts.groupBy ? { groupBy: cmdOpts.groupBy.split(",").map((s) => s.trim()) } : {}),
        out: out as "text" | "csv",
      });
    });

  // ---- image -------------------------------------------------------------
  const image = program.command("image").description("Image generation");

  image
    .command("generate")
    .description("Generate an image from a prompt")
    .argument("<prompt>", "text prompt")
    .option("-o, --output <path>", "output file path (default: image_<ts>.png in cwd)")
    .option("--base64", "print raw base64 to stdout instead of saving a file")
    .option("-m, --model <id>", "image model identifier")
    .action(async (
      prompt: string,
      cmdOpts: { output?: string; base64?: boolean; model?: string },
    ) => {
      await imageGenerateCommand({
        prompt,
        key: ctx.key(),
        ...(cmdOpts.output ? { output: cmdOpts.output } : {}),
        ...(cmdOpts.base64 ? { base64: true } : {}),
        ...(cmdOpts.model ? { model: cmdOpts.model } : {}),
      });
    });
};

export default register;
