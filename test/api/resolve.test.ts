import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";
import { resolveApiContext } from "../../src/api/resolve.js";

useTempOpperHome();

describe("resolveApiContext", () => {
  let prevKey: string | undefined;
  let prevBase: string | undefined;
  beforeEach(() => {
    prevKey = process.env.OPPER_API_KEY;
    prevBase = process.env.OPPER_BASE_URL;
    delete process.env.OPPER_API_KEY;
    delete process.env.OPPER_BASE_URL;
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.OPPER_API_KEY;
    else process.env.OPPER_API_KEY = prevKey;
    if (prevBase === undefined) delete process.env.OPPER_BASE_URL;
    else process.env.OPPER_BASE_URL = prevBase;
  });

  it("uses the stored slot when available", async () => {
    await setSlot("default", { apiKey: "op_live_slot", baseUrl: "https://slot.example" });
    const ctx = await resolveApiContext("default");
    expect(ctx).toEqual({ apiKey: "op_live_slot", baseUrl: "https://slot.example" });
  });

  it("defaults baseUrl to https://api.opper.ai when the slot omits it", async () => {
    await setSlot("default", { apiKey: "op_live_x" });
    const ctx = await resolveApiContext("default");
    expect(ctx.baseUrl).toBe("https://api.opper.ai");
  });

  it("OPPER_API_KEY overrides the slot's apiKey", async () => {
    await setSlot("default", { apiKey: "op_live_slot" });
    process.env.OPPER_API_KEY = "op_live_env";
    const ctx = await resolveApiContext("default");
    expect(ctx.apiKey).toBe("op_live_env");
  });

  it("OPPER_BASE_URL overrides the slot's baseUrl", async () => {
    await setSlot("default", { apiKey: "k", baseUrl: "https://slot" });
    process.env.OPPER_BASE_URL = "https://env";
    const ctx = await resolveApiContext("default");
    expect(ctx.baseUrl).toBe("https://env");
  });

  it("works with only env vars (no slot)", async () => {
    process.env.OPPER_API_KEY = "op_live_envonly";
    const ctx = await resolveApiContext("default");
    expect(ctx).toEqual({ apiKey: "op_live_envonly", baseUrl: "https://api.opper.ai" });
  });

  it("throws AUTH_REQUIRED when no slot and no env var", async () => {
    await expect(resolveApiContext("default")).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });
});
