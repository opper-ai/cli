import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
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

describe("imageGenerateCommand", () => {
  let outDir: string;
  beforeEach(() => {
    postMock.mockReset();
    outDir = mkdtempSync(join(tmpdir(), "opper-image-"));
  });
  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("posts to /v3/call with an image model and saves base64 data to file", async () => {
    await setSlot("default", { apiKey: "k" });
    const base64Bytes = Buffer.from("pretend PNG").toString("base64");
    postMock.mockResolvedValue({ data: base64Bytes });
    const target = join(outDir, "out.png");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await imageGenerateCommand({
        prompt: "a cat",
        output: target,
        key: "default",
      });
      expect(postMock).toHaveBeenCalledWith(
        "/v3/call",
        expect.objectContaining({
          input: "a cat",
          model: expect.stringMatching(/imagen|dall|image/i),
        }),
      );
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target).toString()).toBe("pretend PNG");
    } finally {
      log.mockRestore();
    }
  });

  it("prints base64 to stdout when --base64 is set", async () => {
    await setSlot("default", { apiKey: "k" });
    postMock.mockResolvedValue({ data: "BASE64BYTES==" });
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
    postMock.mockResolvedValue({ data: Buffer.from("x").toString("base64") });
    const target = join(outDir, "out.png");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await imageGenerateCommand({
        prompt: "cat",
        model: "openai/dall-e-3",
        output: target,
        key: "default",
      });
      expect(postMock).toHaveBeenCalledWith(
        "/v3/call",
        expect.objectContaining({ model: "openai/dall-e-3" }),
      );
    } finally {
      log.mockRestore();
    }
  });
});
