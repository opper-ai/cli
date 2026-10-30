import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const postMock = vi.fn();
const getMock = vi.fn();
vi.mock("../../src/api/client.js", () => ({
  OpperApi: vi.fn().mockImplementation(() => ({ post: postMock, get: getMock })),
}));

const { videoGenerateCommand } = await import("../../src/commands/video.js");

useTempOpperHome();

describe("videoGenerateCommand", () => {
  let outDir: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    postMock.mockReset();
    getMock.mockReset();
    outDir = mkdtempSync(join(tmpdir(), "opper-video-"));
    fetchMock = vi.fn().mockResolvedValue(new Response("pretend MP4"));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("submits the normalized fields, polls the status path and saves the clip", async () => {
    await setSlot("default", { apiKey: "k" });
    const still = join(outDir, "first.png");
    writeFileSync(still, "png bytes");
    postMock.mockResolvedValue({ id: "gen_1", status_url: "https://api.opper.ai/v3/artifacts/gen_1/status" });
    getMock
      .mockResolvedValueOnce({ status: "processing" })
      .mockResolvedValueOnce({ status: "completed", url: "https://s3.example/clip.mp4", usage: { cost: 0.4, seconds: 4 } });
    const target = join(outDir, "out.mp4");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await videoGenerateCommand({
        prompt: "the bottle turns",
        key: "default",
        model: "bytedance:ap/seedance-2.5",
        seconds: 4,
        resolution: "720p",
        aspectRatio: "9:16",
        image: still,
        referenceVideos: ["file_abc"],
        generateAudio: false,
        params: ["seed=7"],
        output: target,
        pollEveryMs: 1,
      });
      expect(postMock).toHaveBeenCalledWith("/v3/videos", {
        model: "bytedance:ap/seedance-2.5",
        prompt: "the bottle turns",
        store: false,
        seconds: 4,
        resolution: "720p",
        aspect_ratio: "9:16",
        image: `data:image/png;base64,${Buffer.from("png bytes").toString("base64")}`,
        reference_videos: ["file_abc"],
        parameters: { seed: 7, generate_audio: false },
      });
      expect(getMock).toHaveBeenCalledWith("/v3/artifacts/gen_1/status");
      expect(fetchMock).toHaveBeenCalledWith("https://s3.example/clip.mp4");
      expect(readFileSync(target).toString()).toBe("pretend MP4");
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  it("surfaces a failed job with its reason", async () => {
    await setSlot("default", { apiKey: "k" });
    postMock.mockResolvedValue({ id: "gen_2" });
    getMock.mockResolvedValue({ status: "failed", error: "the input image may contain real person" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        videoGenerateCommand({ prompt: "x", key: "default", output: join(outDir, "x.mp4"), pollEveryMs: 1 }),
      ).rejects.toThrow(/real person/);
      expect(getMock).toHaveBeenCalledWith("/v3/artifacts/gen_2/status");
    } finally {
      err.mockRestore();
    }
  });
});
