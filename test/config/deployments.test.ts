import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { readConfig, setSlot, setDefaultSlot } from "../../src/auth/config.js";
import { DEPLOYMENTS, deploymentForApiUrl, selectedDeployment, slotNameForSelection } from "../../src/config/deployments.js";
import { resolveApiBaseUrl, resolveApiContext, resolveSetupApiBaseUrl } from "../../src/api/resolve.js";
const tempHome = useTempOpperHome();
afterEach(() => vi.unstubAllEnvs());
describe("deployment selection", () => {
  it("recognizes exact deployment API roots, including trailing slashes", () => {
    expect(deploymentForApiUrl("https://api.evroc.on.opper.ai/")?.name).toBe("evroc");
    expect(deploymentForApiUrl("https://api.evroc.on.opper.ai/proxy")).toBeUndefined();
    expect(deploymentForApiUrl("https://api.evroc.on.opper.ai.example.com")).toBeUndefined();
  });
  it("rejects unknown deployments with an actionable error", () => {
    vi.stubEnv("OPPER_DEPLOYMENT", "eu");
    expect(() => selectedDeployment()).toThrow(/main.*evroc/);
  });
  it("uses the saved active slot without a key flag", async () => {
    await setSlot("work", { apiKey: "synthetic", baseUrl: DEPLOYMENTS.evroc.apiUrl });
    expect(await slotNameForSelection()).toBe("work");
  });
  it("selects a matching slot instead of reusing another deployment's credential", async () => {
    await setSlot("default", { apiKey: "main" });
    await setSlot("work", { apiKey: "evroc", baseUrl: DEPLOYMENTS.evroc.apiUrl });
    vi.stubEnv("OPPER_DEPLOYMENT", "evroc");
    expect(await slotNameForSelection()).toBe("work");
    expect((await resolveApiContext()).apiKey).toBe("evroc");
  });
  it("requires explicit choice when several inactive slots match", async () => {
    await setSlot("default", { apiKey: "main" });
    await setSlot("one", { apiKey: "one", baseUrl: DEPLOYMENTS.evroc.apiUrl });
    await setSlot("two", { apiKey: "two", baseUrl: DEPLOYMENTS.evroc.apiUrl });
    vi.stubEnv("OPPER_DEPLOYMENT", "evroc");
    await expect(slotNameForSelection()).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
  it("does not overwrite a slot whose name collides with a deployment", async () => {
    await setSlot("evroc", { apiKey: "custom", baseUrl: "https://custom.example" });
    vi.stubEnv("OPPER_DEPLOYMENT", "evroc");
    await expect(slotNameForSelection()).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
  it("selects a fresh deployment slot on a clean config", async () => {
    vi.stubEnv("OPPER_DEPLOYMENT", "evroc");
    expect(await slotNameForSelection()).toBe("evroc");
    expect(await resolveApiBaseUrl()).toBe(DEPLOYMENTS.evroc.apiUrl);
  });
  it("persists an explicit active slot switch and rejects missing slots", async () => {
    await setSlot("default", { apiKey: "main" });
    await setSlot("work", { apiKey: "evroc", baseUrl: DEPLOYMENTS.evroc.apiUrl });
    await setDefaultSlot("work");
    expect((await readConfig())?.defaultKey).toBe("work");
    expect(await slotNameForSelection()).toBe("work");
    await expect(setDefaultSlot("missing")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect((await readConfig())?.defaultKey).toBe("work");
  });
  it("routes environment keys by deployment without borrowing slot metadata", async () => {
    await setSlot("default", { apiKey: "saved", baseUrl: DEPLOYMENTS.evroc.apiUrl, orgId: 42 });
    vi.stubEnv("OPPER_API_KEY", "environment");
    expect(await resolveApiContext()).toEqual({ apiKey: "environment", baseUrl: DEPLOYMENTS.main.apiUrl });
    await setSlot("another", { apiKey: "unrelated", baseUrl: DEPLOYMENTS.evroc.apiUrl });
    vi.stubEnv("OPPER_DEPLOYMENT", "evroc");
    expect(await resolveApiContext()).toEqual({ apiKey: "environment", baseUrl: DEPLOYMENTS.evroc.apiUrl });
  });
  it("rejects a saved credential from another deployment before requests", async () => {
    await setSlot("default", { apiKey: "main" });
    vi.stubEnv("OPPER_DEPLOYMENT", "evroc");
    await expect(resolveApiContext("default")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
  it("does not send a saved main key to the known Evroc root through a raw override", async () => {
    await setSlot("default", { apiKey: "main" });
    vi.stubEnv("OPPER_BASE_URL", DEPLOYMENTS.evroc.apiUrl);
    await expect(resolveApiContext("default")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
  it("rejects contradictory deployment and raw URL overrides", async () => {
    vi.stubEnv("OPPER_DEPLOYMENT", "evroc");
    vi.stubEnv("OPPER_BASE_URL", DEPLOYMENTS.main.apiUrl);
    await expect(resolveApiBaseUrl()).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
  it.each([
    { name: "OPPER_DEPLOYMENT", value: "evroc", expected: DEPLOYMENTS.evroc.apiUrl },
    { name: "OPPER_BASE_URL", value: "https://custom.example", expected: "https://custom.example" },
  ])("resolves explicit setup $name without reading malformed stored credentials", async ({ name, value, expected }) => {
    writeFileSync(join(tempHome.get(), "config.json"), "{invalid json");
    vi.stubEnv(name, value);
    expect(await resolveSetupApiBaseUrl("unrelated-slot")).toBe(expected);
  });
  it("keeps explicit setup targets independent of saved runtime credential bindings", async () => {
    await setSlot("default", { apiKey: "synthetic-main", baseUrl: DEPLOYMENTS.main.apiUrl });
    vi.stubEnv("OPPER_DEPLOYMENT", "evroc");
    expect(await resolveSetupApiBaseUrl("default")).toBe(DEPLOYMENTS.evroc.apiUrl);
    await expect(resolveApiBaseUrl("default")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(resolveApiContext("default")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
  it("remembers the saved profile endpoint for unqualified setup", async () => {
    await setSlot("work", { apiKey: "synthetic-evroc", baseUrl: DEPLOYMENTS.evroc.apiUrl });
    expect(await resolveSetupApiBaseUrl()).toBe(DEPLOYMENTS.evroc.apiUrl);
  });
  it("keeps legacy custom URL overrides available without a named deployment", async () => {
    await setSlot("custom", { apiKey: "custom", baseUrl: "https://original.example" });
    vi.stubEnv("OPPER_BASE_URL", "https://override.example");
    expect(await resolveApiContext("custom")).toEqual({ apiKey: "custom", baseUrl: "https://override.example" });
  });
});
