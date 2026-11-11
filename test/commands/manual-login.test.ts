import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { select } from "@clack/prompts";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { getSlot, readConfig, setSlot, setDefaultSlot } from "../../src/auth/config.js";
import { DEPLOYMENTS } from "../../src/config/deployments.js";

vi.mock("@clack/prompts", async () => ({
  ...await vi.importActual<typeof import("@clack/prompts")>("@clack/prompts"),
  select: vi.fn(), intro: vi.fn(), outro: vi.fn(), note: vi.fn(), cancel: vi.fn(),
  log: { info: vi.fn(), success: vi.fn() },
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  isCancel: (value: unknown) => typeof value === "symbol",
}));
vi.mock("../../src/auth/device-flow.js", () => ({ runDeviceFlow: vi.fn() }));
vi.mock("../../src/util/open-browser.js", () => ({ openBrowser: vi.fn() }));
const { runDeviceFlow } = await import("../../src/auth/device-flow.js");
const { manualLoginCommand } = await import("../../src/commands/manual-login.js");
const { loginCommand } = await import("../../src/commands/login.js");
useTempOpperHome();
const originalTTY = [process.stdin, process.stdout].map(stream => Object.getOwnPropertyDescriptor(stream, "isTTY"));
function tty(stream: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean) {
  Object.defineProperty(stream, "isTTY", { configurable: true, value });
}

beforeEach(() => {
  vi.stubEnv("OPPER_DEPLOYMENT", undefined);
  vi.stubEnv("OPPER_BASE_URL", undefined);
  tty(process.stdin, true);
  tty(process.stdout, true);
  vi.mocked(select).mockReset();
  vi.mocked(runDeviceFlow).mockReset().mockResolvedValue({ apiKey: "synthetic-new", source: "device-flow" });
});
afterEach(() => {
  for (const [index, stream] of [process.stdin, process.stdout].entries()) {
    const descriptor = originalTTY[index];
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
    else delete (stream as { isTTY?: boolean }).isTTY;
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
const options = { legacyPath: "/nonexistent-legacy-fixture" };
async function seed() {
  await setSlot("main-work", { apiKey: "main", baseUrl: DEPLOYMENTS.main.apiUrl });
  await setSlot("evroc-work", { apiKey: "evroc", baseUrl: DEPLOYMENTS.evroc.apiUrl });
}

describe("manual deployment sign-in", () => {
  it("defaults to main and reveals Evroc only under Other deployment", async () => {
    vi.mocked(select).mockResolvedValueOnce("main");
    expect(await manualLoginCommand(options)).toBe("main");
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ initialValue: "main", options: [
      expect.objectContaining({ value: "main", label: "platform.opper.ai" }),
      expect.objectContaining({ value: "other", label: "Other deployment…" }),
    ] }));
    expect(runDeviceFlow).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: DEPLOYMENTS.main.apiUrl }));
    expect((await readConfig())?.defaultKey).toBe("main");
  });

  it("selects Evroc without rebinding main and remembers the successful profile", async () => {
    await setSlot("default", { apiKey: "main", baseUrl: DEPLOYMENTS.main.apiUrl });
    vi.mocked(select).mockResolvedValueOnce("other").mockResolvedValueOnce("evroc");
    expect(await manualLoginCommand(options)).toBe("evroc");
    expect(vi.mocked(select).mock.calls[1]?.[0]).toEqual(expect.objectContaining({ initialValue: "evroc" }));
    expect(runDeviceFlow).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: DEPLOYMENTS.evroc.apiUrl }));
    expect((await readConfig())?.defaultKey).toBe("evroc");
    expect((await getSlot("default"))?.apiKey).toBe("main");
    expect(process.env.OPPER_DEPLOYMENT).toBeUndefined();
  });

  it("preselects Other and Evroc for a remembered Evroc profile", async () => {
    await seed();
    await setDefaultSlot("evroc-work");
    vi.mocked(select).mockResolvedValueOnce("other").mockResolvedValueOnce("evroc");
    expect(await manualLoginCommand(options)).toBe("evroc-work");
    expect(vi.mocked(select).mock.calls[0]?.[0].initialValue).toBe("other");
    expect(runDeviceFlow).not.toHaveBeenCalled();
    expect((await readConfig())?.defaultKey).toBe("evroc-work");
  });

  it("switches to an existing main profile after choosing main", async () => {
    await seed(); await setDefaultSlot("evroc-work");
    vi.mocked(select).mockResolvedValueOnce("main");
    expect(await manualLoginCommand(options)).toBe("main-work");
    expect((await readConfig())?.defaultKey).toBe("main-work");
    expect(runDeviceFlow).not.toHaveBeenCalled();
  });

  it("Back returns to the first screen without starting OAuth", async () => {
    vi.mocked(select).mockResolvedValueOnce("other").mockResolvedValueOnce("back").mockResolvedValueOnce(Symbol("cancel"));
    expect(await manualLoginCommand(options)).toBeUndefined();
    expect(select).toHaveBeenCalledTimes(3);
    expect(runDeviceFlow).not.toHaveBeenCalled();
    expect(await readConfig()).toBeNull();
  });

  it.each([[Symbol("cancel")], ["other", Symbol("cancel")]])("cancellation preserves the saved profile (%s)", async (...answers) => {
    await seed(); const before = await readConfig();
    for (const answer of answers) vi.mocked(select).mockResolvedValueOnce(answer);
    expect(await manualLoginCommand(options)).toBeUndefined();
    expect(await readConfig()).toEqual(before);
    expect(runDeviceFlow).not.toHaveBeenCalled();
  });

  it("denied approval preserves the active profile and existing credentials", async () => {
    await seed(); const before = await readConfig();
    vi.mocked(select).mockResolvedValueOnce("other").mockResolvedValueOnce("evroc");
    vi.mocked(runDeviceFlow).mockRejectedValueOnce(new Error("access_denied"));
    await expect(manualLoginCommand({ ...options, force: true })).rejects.toThrow("access_denied");
    expect(await readConfig()).toEqual(before);
  });

  it("handled OAuth cancellation during renewal cannot signal successful profile selection", async () => {
    await seed(); const before = await readConfig();
    vi.mocked(select).mockResolvedValueOnce("other").mockResolvedValueOnce("evroc");
    vi.mocked(runDeviceFlow).mockRejectedValueOnce(Symbol("cancel"));
    expect(await manualLoginCommand({ ...options, renew: true })).toBeUndefined();
    expect(await readConfig()).toEqual(before);
  });

  it.each(["option", "environment"])("rejects an explicitly empty URL from %s without a chooser or OAuth", async (mode) => {
    if (mode === "environment") vi.stubEnv("OPPER_BASE_URL", "");
    await expect(manualLoginCommand({ ...options, ...(mode === "option" ? { baseUrl: "" } : {}) })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(select).not.toHaveBeenCalled();
    expect(runDeviceFlow).not.toHaveBeenCalled();
    expect(await readConfig()).toBeNull();
  });

  it("automatic authentication never asks for deployment even in a TTY", async () => {
    await seed();
    expect(await loginCommand({ ...options, key: "evroc-work", activate: false, renew: true })).toBe(true);
    expect(select).not.toHaveBeenCalled();
    expect((await readConfig())?.defaultKey).toBe("main-work");
  });

  it.each(["ambiguous", "collision"])("preserves existing slot selection errors: %s", async (condition) => {
    await setSlot("default", { apiKey: "main" });
    if (condition === "ambiguous") {
      await setSlot("one", { apiKey: "one", baseUrl: DEPLOYMENTS.evroc.apiUrl });
      await setSlot("two", { apiKey: "two", baseUrl: DEPLOYMENTS.evroc.apiUrl });
    } else await setSlot("evroc", { apiKey: "custom", baseUrl: "https://custom.example" });
    vi.mocked(select).mockResolvedValueOnce("other").mockResolvedValueOnce("evroc");
    const before = await readConfig();
    await expect(manualLoginCommand(options)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(runDeviceFlow).not.toHaveBeenCalled(); expect(await readConfig()).toEqual(before);
  });

  it.each(["deployment", "base-env", "base-option", "key", "custom", "stdin", "stdout"])("bypasses the menu for %s", async (mode) => {
    await seed(); await setDefaultSlot("evroc-work");
    let supplied = {};
    if (mode === "deployment") vi.stubEnv("OPPER_DEPLOYMENT", "main");
    if (mode === "base-env") vi.stubEnv("OPPER_BASE_URL", "https://custom.example");
    if (mode === "base-option") supplied = { baseUrl: "https://custom.example" };
    if (mode === "key") supplied = { key: "main-work" };
    if (mode === "custom") await setSlot("evroc-work", { apiKey: "custom", baseUrl: "https://custom.example" });
    if (mode === "stdin") tty(process.stdin, false);
    if (mode === "stdout") tty(process.stdout, false);
    await manualLoginCommand({ ...options, ...supplied });
    expect(select).not.toHaveBeenCalled();
    if (mode === "base-env" || mode === "base-option") expect(runDeviceFlow).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "https://custom.example" }));
  });
});
