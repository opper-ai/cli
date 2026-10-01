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

  it("rejects an expired slot but permits an independent environment key", async () => {
    await setSlot("default", { apiKey: "op_live_old", expiresAt: "2020-01-01T00:00:00Z" });
    await expect(resolveApiContext("default")).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    process.env.OPPER_API_KEY = "op_live_env";
    expect((await resolveApiContext("default")).apiKey).toBe("op_live_env");
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

  it("keeps a resource default separate from inference scope", async () => {
    await setSlot("default", { apiKey: "personal", orgId: 42, defaultProjectUuid: "11111111-1111-4111-8111-111111111111", source: "device-flow" });
    expect(await resolveApiContext("default")).toEqual({ apiKey: "personal", baseUrl: "https://api.opper.ai" });
    expect(await resolveApiContext("default", { useDefaultProject: true, requireProject: true })).toMatchObject({ projectUuid: "11111111-1111-4111-8111-111111111111" });
  });

  it("requires a target for project resources on an org personal slot", async () => {
    await setSlot("default", { apiKey: "personal", orgId: 42, source: "device-flow" });
    await expect(resolveApiContext("default", { requireProject: true })).rejects.toMatchObject({ code: "PROJECT_REQUIRED" });
  });

  it("never borrows host, expiry, or project metadata for an environment key", async () => {
    await setSlot("default", { apiKey: "stored", orgId: 42, baseUrl: "https://staging.example", defaultProjectUuid: "11111111-1111-4111-8111-111111111111", expiresAt: "2020-01-01" });
    process.env.OPPER_API_KEY = "env";
    expect(await resolveApiContext("default", { useDefaultProject: true })).toEqual({ apiKey: "env", baseUrl: "https://api.opper.ai" });
  });

  it("accepts an explicit project for inference and rejects malformed targets", async () => {
    process.env.OPPER_API_KEY = "env";
    const projectUuid = "11111111-1111-4111-8111-111111111111";
    expect(await resolveApiContext("default", { projectUuid })).toMatchObject({ projectUuid });
    await expect(resolveApiContext("default", { projectUuid: "not-a-uuid" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
