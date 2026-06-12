import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useTempOpperHome } from "../helpers/temp-home.js";
import { setSlot } from "../../src/auth/config.js";

const getMock = vi.fn();
const postMock = vi.fn();
const postMultipartMock = vi.fn();
const delMock = vi.fn();
vi.mock("../../src/api/client.js", () => ({
  OpperApi: vi.fn().mockImplementation(() => ({
    get: getMock,
    post: postMock,
    postMultipart: postMultipartMock,
    del: delMock,
  })),
}));

const {
  appsListCommand,
  appsGetCommand,
  appsCreateCommand,
  appsRunCommand,
  appsSecretsSetCommand,
  appsDeleteCommand,
} = await import("../../src/commands/apps.js");

useTempOpperHome();

function captureLog() {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}

describe("apps list + get", () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it("list prints a table from /v3/apps", async () => {
    await setSlot("default", { apiKey: "k" });
    getMock.mockResolvedValue({
      data: [
        {
          id: "a1",
          name: "hermes",
          status: "running",
          runtime: "python",
          config: { cpu: 1, memory: 3072 },
          created_at: "2026-06-11T00:00:00Z",
        },
      ],
    });
    const log = captureLog();
    try {
      await appsListCommand({ key: "default" });
      expect(getMock).toHaveBeenCalledWith("/v3/apps");
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("hermes");
      expect(out).toContain("running");
      expect(out).toContain("1 vCPU / 3072 MiB");
    } finally {
      log.mockRestore();
    }
  });

  it("get prints details and the public invoke URL", async () => {
    await setSlot("default", { apiKey: "k", baseUrl: "https://api.example.test" });
    getMock.mockResolvedValue({
      id: "a1",
      name: "hermes",
      description: "The agent that grows with you",
      status: "running",
      config: { cpu: 1, memory: 3072, timeout: 900 },
    });
    const log = captureLog();
    try {
      await appsGetCommand({ name: "hermes", key: "default" });
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("The agent that grows with you");
      expect(out).toContain("POST https://api.example.test/v3/apps/hermes/run");
    } finally {
      log.mockRestore();
    }
  });
});

describe("apps create", () => {
  beforeEach(() => {
    postMultipartMock.mockReset();
  });

  it("tars the directory and posts multipart with the flag name", async () => {
    await setSlot("default", { apiKey: "k" });
    const dir = await mkdtemp(join(tmpdir(), "opper-app-src-"));
    try {
      await writeFile(join(dir, "agent.py"), "import opper_agents\n");
      postMultipartMock.mockResolvedValue({
        id: "a2",
        name: "my-agent",
        status: "pending",
        deploy_token: "tok",
      });
      const log = captureLog();
      try {
        await appsCreateCommand({ name: "my-agent", dir, key: "default" });
      } finally {
        log.mockRestore();
      }
      expect(postMultipartMock).toHaveBeenCalledTimes(1);
      const [path, form] = postMultipartMock.mock.calls[0] as [string, FormData];
      expect(path).toBe("/v3/apps");
      expect(form.get("name")).toBe("my-agent");
      const source = form.get("source") as Blob;
      expect(source).toBeInstanceOf(Blob);
      expect(source.size).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the opper.yaml name when --name is omitted", async () => {
    await setSlot("default", { apiKey: "k" });
    const dir = await mkdtemp(join(tmpdir(), "opper-app-src-"));
    try {
      await writeFile(join(dir, "opper.yaml"), "name: manifest-agent\ncpu: 1\n");
      await writeFile(join(dir, "agent.py"), "import opper_agents\n");
      postMultipartMock.mockResolvedValue({
        id: "a3",
        name: "manifest-agent",
        status: "pending",
      });
      const log = captureLog();
      try {
        await appsCreateCommand({ dir, key: "default" });
      } finally {
        log.mockRestore();
      }
      const [, form] = postMultipartMock.mock.calls[0] as [string, FormData];
      expect(form.get("name")).toBe("manifest-agent");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("errors when no name is available anywhere", async () => {
    await setSlot("default", { apiKey: "k" });
    const dir = await mkdtemp(join(tmpdir(), "opper-app-src-"));
    try {
      await expect(
        appsCreateCommand({ dir, key: "default" }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("apps run / secrets / delete", () => {
  beforeEach(() => {
    postMock.mockReset();
    delMock.mockReset();
  });

  it("run posts {input} and prints the data string", async () => {
    await setSlot("default", { apiKey: "k" });
    postMock.mockResolvedValue({ data: "Hello, Opper team!" });
    const log = captureLog();
    try {
      await appsRunCommand({ name: "hermes", input: "hi", key: "default" });
      expect(postMock).toHaveBeenCalledWith("/v3/apps/hermes/run", {
        input: "hi",
      });
      const out = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(out).toContain("Hello, Opper team!");
    } finally {
      log.mockRestore();
    }
  });

  it("secrets set posts name+value", async () => {
    await setSlot("default", { apiKey: "k" });
    postMock.mockResolvedValue({});
    const log = captureLog();
    try {
      await appsSecretsSetCommand({
        app: "hermes",
        name: "OPPER_API_KEY",
        value: "v",
        key: "default",
      });
      expect(postMock).toHaveBeenCalledWith("/v3/apps/hermes/secrets", {
        name: "OPPER_API_KEY",
        value: "v",
      });
    } finally {
      log.mockRestore();
    }
  });

  it("delete calls DELETE /v3/apps/{name}", async () => {
    await setSlot("default", { apiKey: "k" });
    delMock.mockResolvedValue(undefined);
    const log = captureLog();
    try {
      await appsDeleteCommand({ name: "hermes", key: "default" });
      expect(delMock).toHaveBeenCalledWith("/v3/apps/hermes");
    } finally {
      log.mockRestore();
    }
  });
});
