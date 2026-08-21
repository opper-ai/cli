import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const postMock = vi.fn();
vi.mock("../../src/api/client.js", () => ({
  OpperApi: vi.fn().mockImplementation(() => ({ post: postMock })),
}));

const { imageGenerateCommand } = await import("../../src/commands/image.js");

useTempOpperHome();

/** A /v3/images 200 body carrying `bytes` as base64. */
function imagesResponse(bytes: string, mimeType = "image/png") {
  return {
    id: "img_test",
    model: "gemini/gemini-3.1-flash-lite-image",
    created: 1787301031,
    data: [{ b64_json: Buffer.from(bytes).toString("base64"), mime_type: mimeType }],
    usage: { cost: 0.03008, images: 1 },
  };
}

describe("imageGenerateCommand", () => {
  let outDir: string;
  beforeEach(() => {
    postMock.mockReset();
    outDir = mkdtempSync(join(tmpdir(), "opper-image-"));
  });
  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("posts to /v3/images and saves the returned bytes to file", async () => {
    await setSlot("default", { apiKey: "k" });
    postMock.mockResolvedValue(imagesResponse("pretend PNG"));
    const target = join(outDir, "out.png");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await imageGenerateCommand({
        prompt: "a cat",
        output: target,
        key: "default",
      });
      expect(postMock).toHaveBeenCalledWith("/v3/images", {
        model: "gemini/gemini-3.1-flash-lite-image",
        prompt: "a cat",
        store: false,
      });
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target).toString()).toBe("pretend PNG");
    } finally {
      log.mockRestore();
    }
  });

  // The old implementation posted to /v3/call, which resolves models as LLMs
  // and 500s for dedicated image models (openai/gpt-image-2 et al.).
  it("never touches the /v3/call function API", async () => {
    await setSlot("default", { apiKey: "k" });
    postMock.mockResolvedValue(imagesResponse("x"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await imageGenerateCommand({
        prompt: "a cat",
        output: join(outDir, "out.png"),
        key: "default",
      });
      const paths = postMock.mock.calls.map((c) => String(c[0]));
      expect(paths).not.toContain("/v3/call");
    } finally {
      log.mockRestore();
    }
  });

  it("prints base64 to stdout when --base64 is set", async () => {
    await setSlot("default", { apiKey: "k" });
    postMock.mockResolvedValue({ data: [{ b64_json: "BASE64BYTES==" }] });
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await imageGenerateCommand({
        prompt: "a cat",
        base64: true,
        key: "default",
      });
      const written = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(written.trim()).toBe("BASE64BYTES==");
    } finally {
      spy.mockRestore();
    }
  });

  it("honours --model override", async () => {
    await setSlot("default", { apiKey: "k" });
    postMock.mockResolvedValue(imagesResponse("x"));
    const target = join(outDir, "out.png");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await imageGenerateCommand({
        prompt: "cat",
        model: "openai/gpt-image-2",
        output: target,
        key: "default",
      });
      expect(postMock).toHaveBeenCalledWith(
        "/v3/images",
        expect.objectContaining({ model: "openai/gpt-image-2" }),
      );
    } finally {
      log.mockRestore();
    }
  });

  // gemini's image models return JPEG, so a hardcoded .png would mislabel it.
  it("derives the generated filename's extension from mime_type", async () => {
    await setSlot("default", { apiKey: "k" });
    postMock.mockResolvedValue(imagesResponse("jpeg bytes", "image/jpeg"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(outDir);
    try {
      await imageGenerateCommand({ prompt: "a cat", key: "default" });
      const written = readdirSync(outDir);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatch(/^image_.*\.jpg$/);
    } finally {
      cwd.mockRestore();
      log.mockRestore();
    }
  });

  it("falls back to .png when the response carries no mime_type", async () => {
    await setSlot("default", { apiKey: "k" });
    postMock.mockResolvedValue({ data: [{ b64_json: Buffer.from("x").toString("base64") }] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(outDir);
    try {
      await imageGenerateCommand({ prompt: "a cat", key: "default" });
      expect(readdirSync(outDir)[0]).toMatch(/^image_.*\.png$/);
    } finally {
      cwd.mockRestore();
      log.mockRestore();
    }
  });

  it("errors when the response carries no image bytes", async () => {
    await setSlot("default", { apiKey: "k" });
    postMock.mockResolvedValue({ data: [] });
    await expect(
      imageGenerateCommand({
        prompt: "a cat",
        output: join(outDir, "out.png"),
        key: "default",
      }),
    ).rejects.toThrow(/did not return image bytes/);
  });

  it("rejects --output together with --base64", async () => {
    await setSlot("default", { apiKey: "k" });
    await expect(
      imageGenerateCommand({
        prompt: "a cat",
        output: join(outDir, "out.png"),
        base64: true,
        key: "default",
      }),
    ).rejects.toThrow(/mutually exclusive/);
    expect(postMock).not.toHaveBeenCalled();
  });
});
