import { InvalidArgumentError } from "commander";
import { OpperError } from "../errors.js";
import { DEFAULT_MODELS } from "../config/models.js";
import { callCommand } from "../commands/call.js";
import {
  modelsListCommand,
  modelsCreateCommand,
  modelsGetCommand,
  modelsDeleteCommand,
  type ModelsListFilters,
} from "../commands/models.js";
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
import { videoGenerateCommand } from "../commands/video.js";
import { projectsListCommand } from "../commands/projects.js";
import type { RegisterFn } from "./types.js";

async function readStdinIfPiped(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

const register: RegisterFn = (program, ctx) => {
  program.command("projects")
    .description("List Opper projects")
    .command("list")
    .description("List live projects in the credential's organization")
    .argument("[filter]", "optional substring filter on name or UUID")
    .action(async (filter: string | undefined) => {
      await projectsListCommand({ key: ctx.key(), ...(filter ? { filter } : {}) });
    });

  // ---- call --------------------------------------------------------------
  program
    .command("call")
    .description("Call a model with instructions and input: the answer goes to stdout, usage and cost to stderr")
    .argument("<name>", "call name, sent as X-Opper-Name (function-scoped project rules match on it)")
    .argument("<instructions>", "instructions, sent as the system message")
    .argument("[input]", "input, sent as the user message (or piped via stdin, for large input)")
    .option("--model <id>", `model identifier (default: ${DEFAULT_MODELS.sonnet})`)
    .option("--stream", "stream the response token-by-token", false)
    .option("--max-tokens <n>", "most tokens the model may generate (default: the model's own limit)", (value: string) => {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new InvalidArgumentError("max tokens must be a whole number above 0");
      }
      return Number(value);
    })
    .action(async (
      name: string,
      instructions: string,
      input: string | undefined,
      cmdOpts: { model?: string; stream?: boolean; maxTokens?: number },
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
        ...(ctx.projectUuid?.() ? { projectUuid: ctx.projectUuid() } : {}),
        ...(cmdOpts.model ? { model: cmdOpts.model } : {}),
        ...(cmdOpts.stream ? { stream: true } : {}),
        ...(cmdOpts.maxTokens !== undefined ? { maxTokens: cmdOpts.maxTokens } : {}),
      });
    });

  // ---- models ------------------------------------------------------------
  const models = program.command("models").description("Manage models");

  models
    .command("list")
    .description("List available models")
    .argument("[filter]", "optional substring filter on name or id")
    .option("--inference-location <list>", "where inference runs, e.g. EU, SE, GLOBAL (comma-separated)")
    .option("--storage-location <list>", "where retained content is stored, e.g. EU (comma-separated)")
    .option("--training <list>", "training stance: no, opt_in, opt_out, yes (comma-separated)")
    .option("--logging <list>", "logging stance: none, abuse_monitoring, limited_debug, other (comma-separated)")
    .option("--moderation <list>", "moderation stance: none, optional, default_on, mandatory (comma-separated)")
    .option("--json", "print the full model objects as JSON", false)
    .action(async (filter: string | undefined, cmdOpts: ModelsListFilters & { json: boolean }) => {
      await modelsListCommand({
        ...cmdOpts,
        key: ctx.key(),
        ...(ctx.projectUuid?.() ? { projectUuid: ctx.projectUuid() } : {}),
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
        ...(ctx.projectUuid?.() ? { projectUuid: ctx.projectUuid() } : {}),
        ...(cmdOpts.extra ? { extraJson: cmdOpts.extra } : {}),
      });
    });

  models
    .command("get")
    .description("Show details of a custom model")
    .argument("<name>", "custom model name")
    .action(async (name: string) => {
      await modelsGetCommand({ name, key: ctx.key(), ...(ctx.projectUuid?.() ? { projectUuid: ctx.projectUuid() } : {}) });
    });

  models
    .command("delete")
    .description("Delete a custom model by name")
    .argument("<name>", "custom model name")
    .action(async (name: string) => {
      await modelsDeleteCommand({ name, key: ctx.key(), ...(ctx.projectUuid?.() ? { projectUuid: ctx.projectUuid() } : {}) });
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
        ...(ctx.projectUuid?.() ? { projectUuid: ctx.projectUuid() } : {}),
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
      await tracesGetCommand({ id, key: ctx.key(), ...(ctx.projectUuid?.() ? { projectUuid: ctx.projectUuid() } : {}) });
    });

  traces
    .command("delete")
    .description("Delete a trace")
    .argument("<id>", "trace id")
    .action(async (id: string) => {
      await tracesDeleteCommand({ id, key: ctx.key(), ...(ctx.projectUuid?.() ? { projectUuid: ctx.projectUuid() } : {}) });
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
        ...(ctx.projectUuid?.() ? { projectUuid: ctx.projectUuid() } : {}),
        ...(cmdOpts.limit !== undefined ? { limit: cmdOpts.limit } : {}),
        ...(cmdOpts.offset !== undefined ? { offset: cmdOpts.offset } : {}),
      });
    });

  indexes
    .command("get")
    .description("Show details of an index")
    .argument("<name>", "index name")
    .action(async (name: string) => {
      await indexesGetCommand({ name, key: ctx.key(), ...(ctx.projectUuid?.() ? { projectUuid: ctx.projectUuid() } : {}) });
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
        ...(ctx.projectUuid?.() ? { projectUuid: ctx.projectUuid() } : {}),
        ...(cmdOpts.embeddingModel ? { embeddingModel: cmdOpts.embeddingModel } : {}),
      });
    });

  indexes
    .command("delete")
    .description("Delete an index by name")
    .argument("<name>", "index name")
    .action(async (name: string) => {
      await indexesDeleteCommand({ name, key: ctx.key(), ...(ctx.projectUuid?.() ? { projectUuid: ctx.projectUuid() } : {}) });
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
        ...(ctx.projectUuid?.() ? { projectUuid: ctx.projectUuid() } : {}),
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
        ...(ctx.projectUuid?.() ? { projectUuid: ctx.projectUuid() } : {}),
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
        ...(ctx.projectUuid?.() ? { projectUuid: ctx.projectUuid() } : {}),
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
    .option("-o, --output <path>", "output file path (default: image_<ts>.<ext> in cwd)")
    .option("--base64", "print raw base64 to stdout instead of saving a file")
    .option("-m, --model <id>", "image model id from `opper models list image`")
    .option("--size <WxH>", "pixel size, e.g. 1024x1536 or 2048x2048 (see the model's params.image)")
    .option("--quality <tier>", "quality tier, e.g. low, medium, high (Gemini image: high is 2K, 4k is 4K)")
    .option("--aspect-ratio <ratio>", "aspect ratio for models that take one, e.g. 16:9")
    .option("--image <src>", "image to edit: a path, URL or file_<id>")
    .option("--reference-image <src>", "further input image (repeatable)", collect, [])
    .option("--param <key=value>", "provider setting forwarded in parameters (repeatable)", collect, [])
    .action(async (
      prompt: string,
      cmdOpts: { output?: string; base64?: boolean; model?: string; size?: string; quality?: string; aspectRatio?: string; image?: string; referenceImage: string[]; param: string[] },
    ) => {
      await imageGenerateCommand({
        prompt,
        key: ctx.key(),
        ...(ctx.projectUuid?.() ? { projectUuid: ctx.projectUuid() } : {}),
        ...(cmdOpts.output ? { output: cmdOpts.output } : {}),
        ...(cmdOpts.base64 ? { base64: true } : {}),
        ...(cmdOpts.model ? { model: cmdOpts.model } : {}),
        ...(cmdOpts.size ? { size: cmdOpts.size } : {}),
        ...(cmdOpts.quality ? { quality: cmdOpts.quality } : {}),
        ...(cmdOpts.aspectRatio ? { aspectRatio: cmdOpts.aspectRatio } : {}),
        ...(cmdOpts.image ? { image: cmdOpts.image } : {}),
        ...(cmdOpts.referenceImage.length ? { referenceImages: cmdOpts.referenceImage } : {}),
        ...(cmdOpts.param.length ? { params: cmdOpts.param } : {}),
      });
    });

  // ---- video -------------------------------------------------------------
  const video = program.command("video").description("Video generation");

  video
    .command("generate")
    .description("Generate a video and save it (submits, waits, downloads)")
    .argument("<prompt>", "text prompt")
    .option("-o, --output <path>", "output file path (default: video_<ts>.mp4 in cwd)")
    .option("-m, --model <id>", "video model id from `opper models list video`, e.g. bytedance:ap/seedance-2.5")
    .option("--seconds <n>", "clip length in seconds", (v) => parseInt(v, 10))
    .option("--resolution <tier>", "output tier, e.g. 480p, 720p, 1080p, 4k")
    .option("--aspect-ratio <ratio>", "e.g. 16:9 or 9:16")
    .option("--image <src>", "first frame (image-to-video): a path, URL or file_<id>")
    .option("--last-image <src>", "ending frame; needs --image")
    .option("--video <src>", "clip to edit, extend or re-animate")
    .option("--audio <src>", "audio the character speaks (lip-sync models)")
    .option("--reference-image <src>", "subject or character image (repeatable)", collect, [])
    .option("--reference-video <src>", "further source video after --video (repeatable)", collect, [])
    .option("--no-audio", "ask for a silent clip (parameters.generate_audio=false; bills less where audio is priced)")
    .option("--param <key=value>", "provider setting forwarded in parameters (repeatable)", collect, [])
    .action(async (
      prompt: string,
      cmdOpts: {
        output?: string; model?: string; seconds?: number; resolution?: string; aspectRatio?: string;
        image?: string; lastImage?: string; video?: string; audio: string | boolean;
        referenceImage: string[]; referenceVideo: string[]; param: string[];
      },
    ) => {
      // commander turns --no-audio into audio=false next to --audio <src>.
      const audioSource = typeof cmdOpts.audio === "string" ? cmdOpts.audio : undefined;
      await videoGenerateCommand({
        prompt,
        key: ctx.key(),
        ...(ctx.projectUuid?.() ? { projectUuid: ctx.projectUuid() } : {}),
        ...(cmdOpts.output ? { output: cmdOpts.output } : {}),
        ...(cmdOpts.model ? { model: cmdOpts.model } : {}),
        ...(cmdOpts.seconds ? { seconds: cmdOpts.seconds } : {}),
        ...(cmdOpts.resolution ? { resolution: cmdOpts.resolution } : {}),
        ...(cmdOpts.aspectRatio ? { aspectRatio: cmdOpts.aspectRatio } : {}),
        ...(cmdOpts.image ? { image: cmdOpts.image } : {}),
        ...(cmdOpts.lastImage ? { lastImage: cmdOpts.lastImage } : {}),
        ...(cmdOpts.video ? { video: cmdOpts.video } : {}),
        ...(audioSource ? { audio: audioSource } : {}),
        ...(cmdOpts.audio === false ? { generateAudio: false } : {}),
        ...(cmdOpts.referenceImage.length ? { referenceImages: cmdOpts.referenceImage } : {}),
        ...(cmdOpts.referenceVideo.length ? { referenceVideos: cmdOpts.referenceVideo } : {}),
        ...(cmdOpts.param.length ? { params: cmdOpts.param } : {}),
      });
    });
};

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export default register;
