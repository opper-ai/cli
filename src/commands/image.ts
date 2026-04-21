import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpperApi } from "../api/client.js";
import { resolveApiContext } from "../api/resolve.js";
import { OpperError } from "../errors.js";
import { brand } from "../ui/colors.js";

const DEFAULT_IMAGE_MODEL = "gcp/imagen-4.0-fast-generate-001-eu";

export interface ImageGenerateOptions {
  prompt: string;
  key: string;
  model?: string;
  output?: string;
  base64?: boolean;
}

interface CallResponse {
  data?: unknown;
}

function timestampName(): string {
  return `image_${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
}

function extractBase64(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.base64 === "string") return obj.base64;
    if (typeof obj.image === "string") return obj.image;
  }
  return null;
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

  const ctx = await resolveApiContext(opts.key);
  const api = new OpperApi(ctx);
  const body = {
    name: "cli/image-generate",
    instructions: "Generate an image for the user's prompt.",
    input: opts.prompt,
    model: opts.model ?? DEFAULT_IMAGE_MODEL,
  };
  const result = await api.post<CallResponse>("/v3/call", body);

  const b64 = extractBase64(result.data);
  if (!b64) {
    throw new OpperError(
      "API_ERROR",
      "Upstream did not return image bytes",
      "Check the model supports image generation.",
    );
  }

  if (opts.base64) {
    process.stdout.write(`${b64}\n`);
    return;
  }

  const target = opts.output ?? join(process.cwd(), timestampName());
  const bytes = Buffer.from(b64, "base64");
  await writeFile(target, bytes);
  console.log(brand.purple(`✓ Saved image to ${target}`));
}
