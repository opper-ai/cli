import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pickMenuChoice: vi.fn(), ask: vi.fn(), reportError: vi.fn(),
  text: vi.fn(), autocomplete: vi.fn(),
  resolveApiContext: vi.fn(), get: vi.fn(), api: vi.fn(), chatCommand: vi.fn(),
}));
vi.mock("../../src/commands/menu/shared.js", () => ({
  pickMenuChoice: mocks.pickMenuChoice, ask: mocks.ask,
  askConfirm: vi.fn(), reportError: mocks.reportError,
}));
vi.mock("@clack/prompts", async () => ({
  ...await vi.importActual<typeof import("@clack/prompts")>("@clack/prompts"),
  text: mocks.text, autocomplete: mocks.autocomplete,
  isCancel: (value: unknown) => typeof value === "symbol",
}));
vi.mock("../../src/api/client.js", () => ({ OpperApi: mocks.api }));
vi.mock("../../src/api/resolve.js", async () => ({
  ...await vi.importActual<typeof import("../../src/api/resolve.js")>("../../src/api/resolve.js"),
  resolveApiContext: mocks.resolveApiContext,
}));
vi.mock("../../src/commands/chat.js", () => ({ chatCommand: mocks.chatCommand }));

const { platformMenu } = await import("../../src/commands/menu/platform.js");
const context = { apiKey: "synthetic-menu-key", baseUrl: "https://api.evroc.on.opper.ai" };
const projectUuid = "11111111-1111-4111-8111-111111111111";

describe("chat menu", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.pickMenuChoice.mockResolvedValueOnce("chat").mockResolvedValue(null);
    mocks.ask.mockResolvedValue("Summarize this text");
    mocks.text.mockResolvedValue("");
    mocks.autocomplete.mockResolvedValue("provider/model-a");
    mocks.resolveApiContext.mockResolvedValue(context);
    mocks.get.mockResolvedValue({ data: [{ id: "provider/model-a" }] });
    mocks.api.mockImplementation(() => ({ get: mocks.get }));
    mocks.chatCommand.mockResolvedValue(undefined);
  });

  it("offers Chat instead of the retired function workflow", async () => {
    mocks.pickMenuChoice.mockReset().mockResolvedValue(null);
    await platformMenu({ key: "evroc-work" });
    const options = mocks.pickMenuChoice.mock.calls[0]?.[1] as Array<{ value: string; label: string }>;
    expect(options).toContainEqual(expect.objectContaining({ value: "chat", label: "Chat…" }));
    expect(options.some(option => option.value === "call")).toBe(false);
  });

  it("uses the selected key/project for the live catalog and the submitted chat", async () => {
    await platformMenu({ key: "evroc-work", projectUuid });
    expect(mocks.resolveApiContext).toHaveBeenCalledWith("evroc-work", { projectUuid });
    expect(mocks.api).toHaveBeenCalledWith(context);
    expect(mocks.get).toHaveBeenCalledWith("/v3/compat/models");
    expect(mocks.ask).toHaveBeenCalledWith("Prompt", { required: true });
    expect(mocks.autocomplete).toHaveBeenCalledWith(expect.objectContaining({
      options: [{ value: "provider/model-a", label: "provider/model-a" }],
    }));
    expect(mocks.chatCommand).toHaveBeenCalledExactlyOnceWith({
      key: "evroc-work", projectUuid, prompt: "Summarize this text", model: "provider/model-a",
    });
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  it("accepts blank optional system instructions without cancelling", async () => {
    mocks.text.mockResolvedValue("   ");
    await platformMenu({ key: "main-work" });
    expect(mocks.chatCommand).toHaveBeenCalledExactlyOnceWith({
      key: "main-work", prompt: "Summarize this text", model: "provider/model-a",
    });
  });

  it("passes optional system instructions", async () => {
    mocks.text.mockResolvedValue("  Be concise.  ");
    await platformMenu({ key: "evroc-work" });
    expect(mocks.chatCommand).toHaveBeenCalledWith(expect.objectContaining({ system: "Be concise." }));
  });

  it("stops before system/catalog prompts when the prompt is cancelled", async () => {
    mocks.ask.mockResolvedValue(null);
    await platformMenu({ key: "evroc-work" });
    expect(mocks.text).not.toHaveBeenCalled();
    expect(mocks.resolveApiContext).not.toHaveBeenCalled();
    expect(mocks.chatCommand).not.toHaveBeenCalled();
  });

  it("stops before fetching models when system instructions are cancelled", async () => {
    mocks.text.mockResolvedValue(Symbol("cancel"));
    await platformMenu({ key: "evroc-work" });
    expect(mocks.resolveApiContext).not.toHaveBeenCalled();
    expect(mocks.autocomplete).not.toHaveBeenCalled();
    expect(mocks.chatCommand).not.toHaveBeenCalled();
  });

  it("does not submit when model selection is cancelled", async () => {
    mocks.autocomplete.mockResolvedValue(Symbol("cancel"));
    await platformMenu({ key: "evroc-work" });
    expect(mocks.get).toHaveBeenCalledOnce();
    expect(mocks.chatCommand).not.toHaveBeenCalled();
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  it("removes invalid and duplicate model IDs from the picker", async () => {
    mocks.get.mockResolvedValue({ data: [
      null, {}, { id: null }, { id: 7 }, { id: "" }, { id: " " },
      { id: "leading space" }, { id: "tab\tid" }, { id: "line\nbreak" }, { id: "control\u0000id" },
      { id: "provider/model-a" }, { id: "provider/model-a" }, { id: "dynamic/team-route" },
    ] });
    await platformMenu({ key: "evroc-work" });
    expect(mocks.autocomplete).toHaveBeenCalledWith(expect.objectContaining({ options: [
      { value: "provider/model-a", label: "provider/model-a" },
      { value: "dynamic/team-route", label: "dynamic/team-route" },
    ] }));
  });

  it("excludes known embedding models while retaining plain compat catalog entries", async () => {
    mocks.get.mockResolvedValue({ data: [
      { id: "provider/embed", opper: { type: "embedding" } },
      { id: "provider/model-a", opper: { type: "llm" } },
      { id: "dynamic/team-route" },
    ] });
    await platformMenu({ key: "evroc-work" });
    expect(mocks.autocomplete).toHaveBeenCalledWith(expect.objectContaining({ options: [
      { value: "provider/model-a", label: "provider/model-a" },
      { value: "dynamic/team-route", label: "dynamic/team-route" },
    ] }));
  });

  it.each([[], [null, { id: " " }], undefined, "invalid catalog"])(
    "reports actionable empty/invalid catalogs without submitting (%j)", async data => {
      mocks.get.mockResolvedValue({ data });
      await platformMenu({ key: "evroc-work" });
      expect(mocks.autocomplete).not.toHaveBeenCalled();
      expect(mocks.chatCommand).not.toHaveBeenCalled();
      expect(mocks.reportError).toHaveBeenCalledWith(expect.objectContaining({
        message: "No chat models are available for the selected account.",
        hint: expect.stringContaining("opper models list"),
      }));
    },
  );

  it("reports catalog failures and never submits a chat", async () => {
    const failure = new Error("Catalog unavailable");
    mocks.get.mockRejectedValue(failure);
    await platformMenu({ key: "evroc-work" });
    expect(mocks.reportError).toHaveBeenCalledWith(failure);
    expect(mocks.autocomplete).not.toHaveBeenCalled();
    expect(mocks.chatCommand).not.toHaveBeenCalled();
  });
});
