import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpperApi } from "../api/client.js";
import { resolveApiContext } from "../api/resolve.js";
import { OpperError } from "../errors.js";
import { brand } from "../ui/colors.js";
import { DEFAULT_MODELS } from "../config/models.js";
import { mediaSource, parseParams } from "./media-source.js";

const DEFAULT_VIDEO_MODEL = DEFAULT_MODELS.video;

export interface VideoGenerateOptions {
  prompt: string;
  key: string;
  projectUuid?: string | undefined;
  model?: string;
  output?: string;
  seconds?: number;
  resolution?: string;
  aspectRatio?: string;
  image?: string;
  lastImage?: string;
  video?: string;
  audio?: string;
  referenceImages?: string[];
  referenceVideos?: string[];
  /** false sends parameters.generate_audio=false (a silent clip bills less where the model renders audio). */
  generateAudio?: boolean;
  params?: string[];
  /** Poll interval and give-up time, in milliseconds (tests shorten them). */
  pollEveryMs?: number;
  timeoutMs?: number;
}

interface SubmitResponse {
  id?: string;
  status_url?: string;
}

interface StatusResponse {
  status?: string;
  url?: string;
  error?: string | { message?: string };
  usage?: { cost?: number; seconds?: number };
}

/** The status URL as a path on the configured API base, so the key and base URL stay the client's. */
function statusPath(submit: SubmitResponse): string {
  if (submit.status_url) {
    try {
      return new URL(submit.status_url).pathname;
    } catch {
      return submit.status_url;
    }
  }
  if (submit.id) {
    return `/v3/artifacts/${submit.id}/status`;
  }
  throw new OpperError("API_ERROR", "The video job was accepted without an id", "Retry, and report it if it persists.");
}

function errorText(err: StatusResponse["error"]): string {
  if (!err) return "the provider gave no reason";
  return typeof err === "string" ? err : err.message ?? JSON.stringify(err);
}

export async function videoGenerateCommand(opts: VideoGenerateOptions): Promise<void> {
  const ctx = await resolveApiContext(opts.key, { projectUuid: opts.projectUuid });
  const api = new OpperApi(ctx);

  const parameters = parseParams(opts.params) ?? {};
  if (opts.generateAudio === false) {
    parameters.generate_audio = false;
  }
  const body: Record<string, unknown> = {
    model: opts.model ?? DEFAULT_VIDEO_MODEL,
    prompt: opts.prompt,
    // A throwaway CLI clip stays out of the org's /v3/files quota; the bytes
    // are downloaded right here.
    store: false,
  };
  if (opts.seconds) body.seconds = opts.seconds;
  if (opts.resolution) body.resolution = opts.resolution;
  if (opts.aspectRatio) body.aspect_ratio = opts.aspectRatio;
  if (opts.image) body.image = await mediaSource(opts.image);
  if (opts.lastImage) body.last_image = await mediaSource(opts.lastImage);
  if (opts.video) body.video = await mediaSource(opts.video);
  if (opts.audio) body.audio = await mediaSource(opts.audio);
  if (opts.referenceImages?.length) body.reference_images = await Promise.all(opts.referenceImages.map(mediaSource));
  if (opts.referenceVideos?.length) body.reference_videos = await Promise.all(opts.referenceVideos.map(mediaSource));
  if (Object.keys(parameters).length > 0) body.parameters = parameters;

  const submit = await api.post<SubmitResponse>("/v3/videos", body);
  const path = statusPath(submit);
  console.error(brand.dim(`Submitted ${submit.id ?? path}; waiting for the clip (usually 30 s to a few minutes)...`));

  const every = opts.pollEveryMs ?? 5000;
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60 * 1000);
  let status: StatusResponse;
  for (;;) {
    status = await api.get<StatusResponse>(path);
    if (status.status === "completed") break;
    if (status.status === "failed") {
      throw new OpperError("API_ERROR", `Video generation failed: ${errorText(status.error)}`, "Check the model's inputs with `opper models list video`.");
    }
    if (Date.now() > deadline) {
      throw new OpperError("API_ERROR", `Gave up waiting for ${submit.id ?? path}`, `Poll it later: GET ${path}`);
    }
    await new Promise((r) => setTimeout(r, every));
  }

  if (!status.url) {
    throw new OpperError("API_ERROR", "The finished job carried no download URL", `Poll it again: GET ${path}`);
  }
  // A presigned URL: fetched without the API key.
  const res = await fetch(status.url);
  if (!res.ok) {
    throw new OpperError("API_ERROR", `Downloading the clip failed (${res.status})`, "The link is valid for an hour; poll the job again for a fresh one.");
  }
  const target = opts.output ?? join(process.cwd(), `video_${new Date().toISOString().replace(/[:.]/g, "-")}.mp4`);
  await writeFile(target, Buffer.from(await res.arrayBuffer()));

  const cost = status.usage?.cost;
  const suffix = typeof cost === "number" ? brand.dim(` ($${cost.toFixed(4)})`) : "";
  console.log(brand.accent(`✓ Saved video to ${target}`) + suffix);
}
