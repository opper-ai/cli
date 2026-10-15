import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const installedTargets = vi.fn();
vi.mock("../../src/setup/skills.js", () => ({ installedTargets }));

const streamMock = vi.fn();
vi.mock("../../src/api/client.js", () => ({
  OpperApi: vi.fn().mockImplementation(() => ({ stream: streamMock })),
}));

const { askCommand } = await import("../../src/commands/ask.js");

useTempOpperHome();

async function* frames(...payloads: unknown[]): AsyncIterable<string> {
  for (const p of payloads) yield typeof p === "string" ? p : JSON.stringify(p);
}

describe("askCommand", () => {
  let out: string;
  let write: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    streamMock.mockReset();
    out = "";
    write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      out += String(chunk);
      return true;
    });
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "ask-skills-"));
    mkdirSync(join(dir, "opper-cli"));
    writeFileSync(join(dir, "opper-cli", "SKILL.md"), "Run opper login.");
    installedTargets.mockReturnValue([{ dir, installed: ["opper-cli"] }]);
  });

  afterEach(() => {
    write.mockRestore();
  });

  it("streams the answer from the compat chat completions endpoint with the skills as system prompt", async () => {
    await setSlot("default", { apiKey: "k" });
    streamMock.mockReturnValue(frames(
      { choices: [{ delta: { role: "assistant" } }] },
      { choices: [{ delta: { content: "Run " } }] },
      { choices: [{ delta: { content: "`opper login`." } }] },
      { choices: [], usage: { prompt_tokens: 90, completion_tokens: 10, total_tokens: 100 } },
    ));

    await askCommand({ question: "how do I log in?", key: "default", model: "gpt-x" });

    const [path, body] = streamMock.mock.calls[0]!;
    expect(path).toBe("/v3/compat/chat/completions");
    expect(body).toMatchObject({ model: "gpt-x", stream: true, stream_options: { include_usage: true } });
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("Run opper login.");
    expect(body.messages[1]).toEqual({ role: "user", content: "how do I log in?" });
    expect(out).toContain("Run `opper login`.");
    expect(out).toContain("100 tokens");
  });

  it("surfaces an in-band stream error instead of printing nothing", async () => {
    await setSlot("default", { apiKey: "k" });
    streamMock.mockReturnValue(frames({ error: { message: "provider failed" } }));
    await expect(askCommand({ question: "q", key: "default" })).rejects.toThrow("provider failed");
  });

  it("fails on an empty answer", async () => {
    await setSlot("default", { apiKey: "k" });
    streamMock.mockReturnValue(frames({ choices: [], usage: { total_tokens: 5 } }));
    await expect(askCommand({ question: "q", key: "default" })).rejects.toThrow("empty answer");
  });
});
