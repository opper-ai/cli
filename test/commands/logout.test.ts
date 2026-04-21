import { describe, it, expect, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot, readConfig } from "../../src/auth/config.js";
import { logoutCommand } from "../../src/commands/logout.js";

useTempOpperHome();

describe("logout", () => {
  it("removes a single slot", async () => {
    await setSlot("default", { apiKey: "op_live_1" });
    await setSlot("staging", { apiKey: "op_live_2" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await logoutCommand({ key: "staging", all: false });
      const cfg = await readConfig();
      expect(cfg?.keys.staging).toBeUndefined();
      expect(cfg?.keys.default).toBeDefined();
    } finally {
      log.mockRestore();
    }
  });

  it("--all clears every slot", async () => {
    await setSlot("default", { apiKey: "op_live_1" });
    await setSlot("staging", { apiKey: "op_live_2" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await logoutCommand({ key: "default", all: true, yes: true });
      const cfg = await readConfig();
      expect(Object.keys(cfg?.keys ?? {})).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
  });

  it("reports when nothing to do", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await logoutCommand({ key: "default", all: false });
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out.toLowerCase()).toContain("nothing to log out");
    } finally {
      log.mockRestore();
    }
  });
});
