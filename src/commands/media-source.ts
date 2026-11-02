import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { OpperError } from "../errors.js";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
};

/**
 * A media input the gateway accepts as is: an http(s) URL, a data-URI, or a
 * `file_<id>` from /v3/files. Anything else is read as a local file and sent
 * as a data-URI, so `--image ./cat.png` works without an upload step.
 */
export async function mediaSource(arg: string): Promise<string> {
  const value = arg.trim();
  if (/^(https?:\/\/|data:|file_)/.test(value)) {
    return value;
  }
  const mime = MIME_BY_EXTENSION[extname(value).toLowerCase()];
  if (!mime) {
    throw new OpperError(
      "API_ERROR",
      `Cannot tell the media type of ${value}`,
      "Pass an http(s) URL, a file_<id>, or a local file ending in .png, .jpg, .webp, .mp4, .mov, .webm, .mp3, .wav, .m4a or .ogg.",
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(value);
  } catch {
    throw new OpperError("API_ERROR", `Cannot read ${value}`, "Check the path, or pass a URL or file_<id> instead.");
  }
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** Parses repeated `--param key=value` flags; values that read as JSON (numbers, booleans, lists) are sent typed. */
export function parseParams(pairs: string[] | undefined): Record<string, unknown> | undefined {
  if (!pairs || pairs.length === 0) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const i = pair.indexOf("=");
    if (i <= 0) {
      throw new OpperError("API_ERROR", `--param ${pair} is not key=value`, "For example --param seed=7 or --param negative_prompt=blur.");
    }
    const key = pair.slice(0, i).trim();
    const raw = pair.slice(i + 1);
    try {
      out[key] = JSON.parse(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}
