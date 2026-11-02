import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpperApi } from "../api/client.js";
import { resolveApiContext } from "../api/resolve.js";
import { OpperError } from "../errors.js";
import { brand } from "../ui/colors.js";
import { DEFAULT_MODELS } from "../config/models.js";
import { mediaSource, parseParams } from "./media-source.js";

const DEFAULT_IMAGE_MODEL = DEFAULT_MODELS.image;

export interface ImageGenerateOptions {
  prompt: string;
  key: string;
  projectUuid?: string | undefined;
  model?: string;
  output?: string;
  base64?: boolean;
  /** Pixel size WxH, e.g. 2048x2048; a model's params.image lists what it takes. */
  size?: string;
  quality?: string;
  aspectRatio?: string;
  /** Image to edit: a path, URL or file_<id>. */
  image?: string;
  referenceImages?: string[];
  params?: string[];
}

/** One entry of POST /v3/images' `data[]`. */
interface ImageData {
  b64_json?: string;
  mime_type?: string;
  revised_prompt?: string;
}

interface ImagesResponse {
  data?: ImageData[];
  usage?: { cost?: number; images?: number };
}

/**
 * File extension for the bytes the gateway returned. Models don't all emit
 * PNG — gemini's image models return JPEG — so naming every file `.png`
 * writes a mislabelled image.
 */
function extensionFor(mimeType: string | undefined): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}

function timestampName(ext: string): string {
  return `image_${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
}

export async function imageGenerateCommand(
  opts: ImageGenerateOptions,
): Promise<void> {
  if (opts.output && opts.base64) {
    throw new OpperError(
      "API_ERROR",
      "--output and --base64 are mutually exclusive",
      "Pick one output mode.",
    );
  }

  const ctx = await resolveApiContext(opts.key, { projectUuid: opts.projectUuid });
  const api = new OpperApi(ctx);
  // POST /v3/images is the image endpoint. /v3/call is the *function* API:
  // it only reaches image-output chat models, and a dedicated image model
  // (openai/gpt-image-2 et al., type "image") fails model resolution there
  // with a 500. `store: false` keeps a throwaway CLI generation out of the
  // org's /v3/files quota — we hand the caller the bytes right here.
  const body: Record<string, unknown> = {
    model: opts.model ?? DEFAULT_IMAGE_MODEL,
    prompt: opts.prompt,
    store: false,
  };
  if (opts.size) body.size = opts.size;
  if (opts.quality) body.quality = opts.quality;
  if (opts.aspectRatio) body.aspect_ratio = opts.aspectRatio;
  if (opts.image) body.image = await mediaSource(opts.image);
  if (opts.referenceImages?.length) body.reference_images = await Promise.all(opts.referenceImages.map(mediaSource));
  const parameters = parseParams(opts.params);
  if (parameters) body.parameters = parameters;
  const result = await api.post<ImagesResponse>("/v3/images", body);

  const image = result.data?.[0];
  const b64 = image?.b64_json;
  if (!b64) {
    throw new OpperError(
      "API_ERROR",
      "Upstream did not return image bytes",
      "Check the model supports image generation (`opper models list image`).",
    );
  }

  if (opts.base64) {
    process.stdout.write(`${b64}\n`);
    return;
  }

  const target =
    opts.output ?? join(process.cwd(), timestampName(extensionFor(image.mime_type)));
  const bytes = Buffer.from(b64, "base64");
  await writeFile(target, bytes);

  const cost = result.usage?.cost;
  const suffix = typeof cost === "number" ? brand.dim(` ($${cost.toFixed(4)})`) : "";
  console.log(brand.accent(`✓ Saved image to ${target}`) + suffix);
}
