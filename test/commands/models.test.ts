import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const getMock = vi.fn();
const postMock = vi.fn();
const delMock = vi.fn();
vi.mock("../../src/api/client.js", () => ({
  OpperApi: vi.fn().mockImplementation(() => ({ get: getMock, post: postMock, del: delMock })),
}));

const { modelsListCommand } = await import("../../src/commands/models.js");

useTempOpperHome();

describe("modelsListCommand", () => {
  it("prints a table of model name, id, context_window", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({
      models: [
        { name: "Claude Opus 4.7", id: "anthropic/claude-opus-4-7", context_window: 200000 },
        { name: "GPT-4o", id: "openai/gpt-4o", context_window: 128000 },
      ],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await modelsListCommand({ key: "default" });
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("anthropic/claude-opus-4-7");
      expect(out).toContain("openai/gpt-4o");
      expect(getMock).toHaveBeenCalledWith("/v3/models");
    } finally {
      log.mockRestore();
    }
  });

  it("filters by substring match on name or id", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({
      models: [
        { name: "Claude Opus", id: "anthropic/claude-opus-4-7", context_window: 1 },
        { name: "GPT-4o", id: "openai/gpt-4o", context_window: 1 },
      ],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await modelsListCommand({ key: "default", filter: "claude" });
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("anthropic/claude-opus-4-7");
      expect(out).not.toContain("openai/gpt-4o");
    } finally {
      log.mockRestore();
    }
  });
});

describe("models create + get", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it("create posts to /v2/models/custom with identifier, api_key, extra", async () => {
    await setSlot("default", { apiKey: "k" });
    postMock.mockResolvedValue({
      id: "m_new",
      name: "my-gpt4",
      identifier: "azure/gpt-4o",
    });
    const { modelsCreateCommand } = await import("../../src/commands/models.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await modelsCreateCommand({
        name: "my-gpt4",
        identifier: "azure/gpt-4o",
        apiKey: "sk-xxx",
        extraJson: JSON.stringify({ api_base: "https://example.openai.azure.com" }),
        key: "default",
      });
      expect(postMock).toHaveBeenCalledWith(
        "/v2/models/custom",
        expect.objectContaining({
          name: "my-gpt4",
          identifier: "azure/gpt-4o",
          api_key: "sk-xxx",
          extra: { api_base: "https://example.openai.azure.com" },
        }),
      );
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("my-gpt4");
    } finally {
      log.mockRestore();
    }
  });

  it("get fetches custom model by name", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockReset();
    getMock.mockResolvedValue({
      id: "m_1",
      name: "my-gpt4",
      identifier: "azure/gpt-4o",
      type: "llm",
    });
    const { modelsGetCommand } = await import("../../src/commands/models.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await modelsGetCommand({ name: "my-gpt4", key: "default" });
      expect(getMock).toHaveBeenCalledWith("/v2/models/custom/by-name/my-gpt4");
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("azure/gpt-4o");
    } finally {
      log.mockRestore();
    }
  });
});

describe("models delete", () => {
  beforeEach(() => {
    getMock.mockReset();
    delMock.mockReset();
  });

  it("looks up by name, DELETEs by id", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({ id: "m_abc", name: "my-gpt4", identifier: "azure/gpt-4o" });
    delMock.mockResolvedValue(undefined);
    const { modelsDeleteCommand } = await import("../../src/commands/models.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await modelsDeleteCommand({ name: "my-gpt4", key: "default" });
      expect(getMock).toHaveBeenCalledWith("/v2/models/custom/by-name/my-gpt4");
      expect(delMock).toHaveBeenCalledWith("/v2/models/custom/m_abc");
    } finally {
      log.mockRestore();
    }
  });
});
