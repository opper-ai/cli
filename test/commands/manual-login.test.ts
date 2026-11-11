import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configPath, legacyMigrationSentinelPath } from "../../src/auth/paths.js";
import { select, log } from "@clack/prompts";
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
const home = useTempOpperHome();
const originalTTY = [process.stdin, process.stdout].map(stream => Object.getOwnPropertyDescriptor(stream, "isTTY"));
function tty(stream: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean) {
  Object.defineProperty(stream, "isTTY", { configurable: true, value });
}

beforeEach(() => {
  vi.stubEnv("OPPER_DEPLOYMENT", undefined);
  vi.stubEnv("OPPER_BASE_URL", undefined);
  tty(process.stdin, true);
  tty(process.stdout, true);
  vi.mocked(select).mockReset().mockResolvedValue(Symbol("cancel"));
  vi.mocked(log.info).mockClear();
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


describe("manual login with legacy-only credentials", () => {
  function legacy(baseUrl?: string) {
    const path = join(home.get(), ".oppercli-fixture");
    writeFileSync(path, "api_keys:\n  default:\n    key: synthetic-legacy\n" + (baseUrl ? `    baseUrl: ${baseUrl}\n` : ""));
    return { legacyPath: path };
  }
  it("reuses legacy default main before slot resolution without an OAuth request", async () => {
    const opts = legacy();
    vi.mocked(select).mockResolvedValueOnce("main");
    expect(await manualLoginCommand(opts)).toBe("default");
    expect(runDeviceFlow).not.toHaveBeenCalled();
    expect((await readConfig())?.keys).toEqual({ default: { apiKey: "synthetic-legacy", source: "migrated" } });
    expect((await readConfig())?.defaultKey).toBe("default");
    expect(log.info).toHaveBeenCalledExactlyOnceWith("Migrated legacy ~/.oppercli into ~/.opper/config.json (one-time).");
  });
  it("preselects the legacy Evroc profile and reuses its original slot", async () => {
    const opts = legacy(DEPLOYMENTS.evroc.apiUrl);
    vi.mocked(select).mockResolvedValueOnce("other").mockResolvedValueOnce("evroc");
    expect(await manualLoginCommand(opts)).toBe("default");
    expect(vi.mocked(select).mock.calls[0]?.[0].initialValue).toBe("other");
    expect(runDeviceFlow).not.toHaveBeenCalled();
    expect((await readConfig())?.defaultKey).toBe("default");
    expect((await getSlot())?.baseUrl).toBe(DEPLOYMENTS.evroc.apiUrl);
  });
  it("retains a custom legacy endpoint without prompting or starting OAuth", async () => {
    expect(await manualLoginCommand(legacy("https://custom.example"))).toBe("default");
    expect(select).not.toHaveBeenCalled(); expect(runDeviceFlow).not.toHaveBeenCalled();
    expect((await getSlot())?.baseUrl).toBe("https://custom.example");
  });
  it.each([[Symbol("cancel")], ["other", Symbol("cancel")]])("does not migrate or stamp on chooser cancellation (%s)", async (...answers) => {
    const opts = legacy(DEPLOYMENTS.evroc.apiUrl);
    const original = readFileSync(opts.legacyPath, "utf8");
    for (const answer of answers) vi.mocked(select).mockResolvedValueOnce(answer);
    expect(await manualLoginCommand(opts)).toBeUndefined();
    expect(existsSync(configPath())).toBe(false);
    expect(existsSync(legacyMigrationSentinelPath())).toBe(false);
    expect(readFileSync(opts.legacyPath, "utf8")).toBe(original);
    expect(log.info).not.toHaveBeenCalled(); expect(runDeviceFlow).not.toHaveBeenCalled();
  });
  it("preserves --force skipping legacy preview and migration", async () => {
    const opts = legacy(DEPLOYMENTS.evroc.apiUrl);
    vi.mocked(select).mockResolvedValueOnce("main");
    expect(await manualLoginCommand({ ...opts, force: true })).toBe("main");
    expect(vi.mocked(select).mock.calls[0]?.[0].initialValue).toBe("main");
    expect((await readConfig())?.keys.default).toBeUndefined();
    expect(existsSync(legacyMigrationSentinelPath())).toBe(false);
    expect(runDeviceFlow).toHaveBeenCalledOnce();
  });
  it.each(["config", "sentinel"])("does not import stale legacy state when %s exists", async (guard) => {
    const opts = legacy(DEPLOYMENTS.evroc.apiUrl);
    if (guard === "config") await setSlot("current", { apiKey: "synthetic-current" });
    else writeFileSync(legacyMigrationSentinelPath(), "already-migrated\n");
    vi.mocked(select).mockResolvedValueOnce("main");
    expect(await manualLoginCommand(opts)).toBe(guard === "config" ? "current" : "main");
    expect(vi.mocked(select).mock.calls[0]?.[0].initialValue).toBe("main");
    expect((await readConfig())?.keys.default).toBeUndefined();
    expect(log.info).not.toHaveBeenCalled();
    if (guard === "config") expect(runDeviceFlow).not.toHaveBeenCalled();
    else expect(readFileSync(legacyMigrationSentinelPath(), "utf8")).toBe("already-migrated\n");
  });
  it("does not overwrite a config created while the legacy chooser is open", async () => {
    const opts = legacy(DEPLOYMENTS.evroc.apiUrl);
    vi.mocked(select).mockImplementationOnce(async () => {
      await setSlot("concurrent", { apiKey: "synthetic-concurrent" });
      return "main";
    });
    expect(await manualLoginCommand(opts)).toBe("concurrent");
    expect((await readConfig())?.keys).toEqual({ concurrent: { apiKey: "synthetic-concurrent" } });
    expect(runDeviceFlow).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });
  it.each(["option-empty", "option-relative", "option-malformed", "environment-empty", "environment-relative", "environment-malformed", "deployment-invalid", "option-conflict", "environment-conflict"])("rejects %s before migrating a legacy profile", async (mode) => {
    const opts = legacy();
    const original = readFileSync(opts.legacyPath, "utf8");
    let baseUrl: string | undefined;
    const invalid = mode.endsWith("empty") ? "" : mode.endsWith("relative") ? "/relative" : "https://[invalid";
    if (mode.startsWith("option-")) baseUrl = invalid;
    if (mode.startsWith("environment-")) vi.stubEnv("OPPER_BASE_URL", invalid);
    if (mode === "deployment-invalid") vi.stubEnv("OPPER_DEPLOYMENT", "unknown");
    if (mode.endsWith("conflict")) {
      vi.stubEnv("OPPER_DEPLOYMENT", "main");
      if (mode === "option-conflict") baseUrl = DEPLOYMENTS.evroc.apiUrl;
      else vi.stubEnv("OPPER_BASE_URL", DEPLOYMENTS.evroc.apiUrl);
    }
    await expect(manualLoginCommand({ ...opts, ...(baseUrl !== undefined ? { baseUrl } : {}) })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(existsSync(configPath())).toBe(false);
    expect(existsSync(legacyMigrationSentinelPath())).toBe(false);
    expect(readFileSync(opts.legacyPath, "utf8")).toBe(original);
    expect(select).not.toHaveBeenCalled(); expect(runDeviceFlow).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });
  it.each(["option", "environment"])("low-level login also validates %s before legacy migration", async (mode) => {
    const opts = legacy();
    const original = readFileSync(opts.legacyPath, "utf8");
    if (mode === "environment") vi.stubEnv("OPPER_BASE_URL", "");
    await expect(loginCommand({ ...opts, key: "default", ...(mode === "option" ? { baseUrl: "" } : {}) })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(existsSync(configPath())).toBe(false);
    expect(existsSync(legacyMigrationSentinelPath())).toBe(false);
    expect(readFileSync(opts.legacyPath, "utf8")).toBe(original);
    expect(runDeviceFlow).not.toHaveBeenCalled();
  });
  it.each([
    { override: "", named: false }, { override: "/relative", named: false },
    { override: "https://[invalid", named: false }, { override: DEPLOYMENTS.evroc.apiUrl, named: false },
    { override: "", named: true }, { override: "/relative", named: true },
    { override: "https://[invalid", named: true }, { override: DEPLOYMENTS.evroc.apiUrl, named: true },
  ])("an explicit option overrides environment URL $override (named=$named)", async ({ override, named }) => {
    vi.stubEnv("OPPER_BASE_URL", override);
    if (named) vi.stubEnv("OPPER_DEPLOYMENT", "main");
    expect(await manualLoginCommand({ ...legacy(), baseUrl: DEPLOYMENTS.main.apiUrl })).toBe("default");
    expect((await getSlot())?.apiKey).toBe("synthetic-legacy");
    expect(select).not.toHaveBeenCalled(); expect(runDeviceFlow).not.toHaveBeenCalled();
  });
  it("low-level explicit URL overrides conflicting environment URL for the named deployment", async () => {
    vi.stubEnv("OPPER_DEPLOYMENT", "main");
    vi.stubEnv("OPPER_BASE_URL", DEPLOYMENTS.evroc.apiUrl);
    expect(await loginCommand({ ...legacy(), key: "default", baseUrl: DEPLOYMENTS.main.apiUrl })).toBe(true);
    expect((await getSlot())?.apiKey).toBe("synthetic-legacy");
    expect(runDeviceFlow).not.toHaveBeenCalled();
  });
  it("an explicit URL still rejects an unknown deployment before migration", async () => {
    const opts = legacy();
    vi.stubEnv("OPPER_DEPLOYMENT", "unknown");
    await expect(manualLoginCommand({ ...opts, baseUrl: DEPLOYMENTS.main.apiUrl })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(existsSync(configPath())).toBe(false);
    expect(existsSync(legacyMigrationSentinelPath())).toBe(false);
    expect(select).not.toHaveBeenCalled(); expect(runDeviceFlow).not.toHaveBeenCalled();
  });
  it("explicit named selection resolves the migrated matching slot", async () => {
    vi.stubEnv("OPPER_DEPLOYMENT", "evroc");
    expect(await manualLoginCommand(legacy(DEPLOYMENTS.evroc.apiUrl))).toBe("default");
    expect(select).not.toHaveBeenCalled(); expect(runDeviceFlow).not.toHaveBeenCalled();
  });
});
