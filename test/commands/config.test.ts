import { describe, it, expect, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { readConfig, setSlot } from "../../src/auth/config.js";
import {
  configAddCommand,
  configListCommand,
  configGetCommand,
  configRemoveCommand,
  configProjectCommand,
} from "../../src/commands/config.js";

useTempOpperHome();

describe("config commands", () => {
  it("sets and clears resource defaults without changing the credential binding", async () => {
    await setSlot("default", { apiKey: "k", orgId: 42, projectUuid: "old-server-binding" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await configProjectCommand("default", "11111111-1111-4111-8111-111111111111");
      expect((await readConfig())?.keys.default).toMatchObject({ apiKey: "k", projectUuid: "old-server-binding", defaultProjectUuid: "11111111-1111-4111-8111-111111111111" });
      await configProjectCommand("default");
      expect((await readConfig())?.keys.default?.defaultProjectUuid).toBeUndefined();
      expect((await readConfig())?.keys.default?.projectUuid).toBe("old-server-binding");
      await expect(configProjectCommand("default", "bad")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    } finally { log.mockRestore(); }
  });
  it("add stores a slot", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await configAddCommand({
        name: "staging",
        apiKey: "op_live_stg",
      });
      const cfg = await readConfig();
      expect(cfg?.keys.staging?.apiKey).toBe("op_live_stg");
      expect(cfg?.keys.staging?.source).toBe("manual");
    } finally {
      log.mockRestore();
    }
  });

  it("add accepts --base-url", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await configAddCommand({
        name: "staging",
        apiKey: "op_live_stg",
        baseUrl: "https://staging.example",
      });
      const cfg = await readConfig();
      expect(cfg?.keys.staging?.baseUrl).toBe("https://staging.example");
    } finally {
      log.mockRestore();
    }
  });

  it("list prints one line per slot with masked keys", async () => {
    await setSlot("default", { apiKey: "op_live_abc123def456" });
    await setSlot("staging", { apiKey: "op_live_stagingKey9999" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await configListCommand();
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("default");
      expect(out).toContain("staging");
      expect(out).not.toContain("op_live_abc123def456");
    } finally {
      log.mockRestore();
    }
  });

  it("get prints the raw key (for scripts)", async () => {
    await setSlot("default", { apiKey: "op_live_raw" });
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await configGetCommand({ name: "default" });
      const written = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(written.trim()).toBe("op_live_raw");
    } finally {
      spy.mockRestore();
    }
  });

  it("get throws AUTH_REQUIRED when slot missing", async () => {
    await expect(configGetCommand({ name: "missing" })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });

  it("remove deletes the slot", async () => {
    await setSlot("default", { apiKey: "k1" });
    await setSlot("staging", { apiKey: "k2" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await configRemoveCommand({ name: "staging" });
      const cfg = await readConfig();
      expect(cfg?.keys.staging).toBeUndefined();
      expect(cfg?.keys.default).toBeDefined();
    } finally {
      log.mockRestore();
    }
  });
});
