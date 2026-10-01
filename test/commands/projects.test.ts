import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";
import { projectsListCommand } from "../../src/commands/projects.js";
import { Command } from "commander";
import registerPlatform from "../../src/cli/platform.js";

useTempOpperHome();

describe("project discovery", () => {
  let server: Server;
  let baseUrl: string;
  let requests: Array<{ path: string; authorization?: string; project?: string }>;
  let statusCode: number;
  let projects: Array<{ name: string | null; uuid: string }>;

  beforeEach(async () => {
    vi.stubEnv("OPPER_API_KEY", "");
    delete process.env.OPPER_API_KEY;
    vi.stubEnv("OPPER_BASE_URL", "");
    delete process.env.OPPER_BASE_URL;
    requests = [];
    statusCode = 200;
    projects = [
      { name: "Research", uuid: "b82ef986-282c-4bf5-b48e-105342e7f37d" },
      { name: "Production", uuid: "41a240ce-a5ef-42b3-8bb2-28e39894145b" },
    ];
    server = createServer((req, res) => {
      requests.push({ path: req.url!, authorization: req.headers.authorization,
        project: req.headers["x-opper-project"] as string | undefined });
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(statusCode === 200 ? projects : { error: "Invalid API key" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await setSlot("work", { apiKey: "test-key", baseUrl, source: "device-flow", orgId: 2,
      defaultProjectUuid: "ffffffff-ffff-ffff-ffff-ffffffffffff" });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const output = () => vi.mocked(console.log).mock.calls.map((call) => String(call[0])).join("\n");

  it("lists names and UUIDs using the selected credential without a resource default", async () => {
    await projectsListCommand({ key: "work" });
    expect(requests).toEqual([{ path: "/v1/projects", authorization: "Bearer test-key", project: undefined }]);
    expect(output()).toContain("NAME");
    expect(output()).toContain("UUID");
    for (const project of projects) {
      expect(output()).toContain(project.name);
      expect(output()).toContain(project.uuid);
    }
  });

  it.each(["research", "B82EF986"])("filters by name or UUID without case sensitivity: %s", async (filter) => {
    await projectsListCommand({ key: "work", filter });
    expect(output()).toContain("Research");
    expect(output()).not.toContain("Production");
  });

  it("handles unnamed projects and empty results", async () => {
    projects[0]!.name = null;
    await projectsListCommand({ key: "work" });
    expect(output()).toContain(projects[0]!.uuid);
    projects = [];
    await projectsListCommand({ key: "work" });
    expect(output()).toContain("(no results)");
  });

  it("requires a credential before making a request", async () => {
    await expect(projectsListCommand({ key: "missing" })).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(requests).toEqual([]);
  });

  it("registers projects list with slot and filter options, ignoring the resource target", async () => {
    const program = new Command().option("--key <slot>", "", "default")
      .option("--project-uuid <uuid>");
    registerPlatform(program, {
      key: () => program.opts().key as string,
      projectUuid: () => program.opts().projectUuid as string | undefined,
      version: "test",
    });
    await program.parseAsync(["--key", "work", "--project-uuid",
      "ffffffff-ffff-ffff-ffff-ffffffffffff", "projects", "list", "research"], { from: "user" });
    expect(requests).toEqual([{ path: "/v1/projects", authorization: "Bearer test-key", project: undefined }]);
    expect(output()).toContain("Research");
    expect(output()).not.toContain("Production");
  });

  it("rejects a revoked credential without printing projects", async () => {
    statusCode = 401;
    await expect(projectsListCommand({ key: "work" })).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(output()).toBe("");
  });
});
