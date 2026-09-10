import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setSlot } from "../../src/auth/config.js";
import { editorsOpenCodeCommand } from "../../src/commands/editors.js";
import { opencodeConfigPath } from "../../src/util/editor-paths.js";

// Exercise the real command, credential lookup, config reader, and writer.
// An already configured no-op must not depend on the gateway being available.
describe("OpenCode editor setup with an existing provider", () => {
  let sandbox: string;
  let previousCwd: string;
  let logs: string[];
  const fetchMock = vi.fn<typeof fetch>();
  const originalBytes = `${JSON.stringify({
    theme: "user-theme",
    provider: {
      opper: {
        options: { baseURL: "https://gateway.example.test/v3/compat" },
        models: { "custom/model": { name: "User model" } },
      },
      other: { name: "Other provider" },
    },
  }, null, "\t")}\n`;

  beforeEach(async () => {
    sandbox = mkdtempSync(join(tmpdir(), "opper-editors-noop-"));
    previousCwd = process.cwd();
    const project = join(sandbox, "project");
    mkdirSync(project);
    process.chdir(project);
    vi.stubEnv("OPPER_HOME", join(sandbox, "opper"));
    vi.stubEnv("OPPER_EDITOR_HOME", join(sandbox, "editor"));
    vi.stubEnv("OPPER_API_KEY", undefined);
    vi.stubEnv("OPPER_BASE_URL", undefined);
    await setSlot("default", {
      apiKey: "op_live_expired_test_key",
      baseUrl: "https://api.example.test",
    });
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    logs = [];
    vi.spyOn(console, "log").mockImplementation((message: unknown) => {
      logs.push(String(message));
    });
  });

  afterEach(() => {
    process.chdir(previousCwd);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(sandbox, { recursive: true, force: true });
  });

  for (const location of ["global", "local"] as const) {
    describe(`${location} config`, () => {
      let configPath: string;

      beforeEach(() => {
        configPath = opencodeConfigPath(location);
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, originalBytes);
      });

      it.each(["expired credentials", "gateway outage"])(
        "returns already-configured without fetching or writing despite %s",
        async (failure) => {
          if (failure === "expired credentials") {
            fetchMock.mockResolvedValue(new Response("Unauthorized", { status: 401 }));
          } else {
            fetchMock.mockRejectedValue(new Error("Gateway unavailable"));
          }

          await expect(editorsOpenCodeCommand({
            location,
            overwrite: false,
          })).resolves.toBeUndefined();

          expect(fetchMock).not.toHaveBeenCalled();
          expect(logs).toEqual([
            `OpenCode config at ${configPath} already has an Opper provider. Pass --overwrite to replace it.`,
          ]);
          expect(readFileSync(configPath, "utf8")).toBe(originalBytes);
        },
      );

      it("still reports authentication failure on overwrite and preserves the existing file", async () => {
        fetchMock.mockResolvedValue(new Response("Unauthorized", { status: 401 }));

        await expect(editorsOpenCodeCommand({
          location,
          overwrite: true,
        })).rejects.toMatchObject({ code: "AUTH_EXPIRED" });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe("https://api.example.test/v3/compat/models");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer op_live_expired_test_key");
        expect(logs).toEqual([]);
        expect(readFileSync(configPath, "utf8")).toBe(originalBytes);
      });

      it("recognizes an existing provider in JSONC without fetching or changing any bytes", async () => {
        const jsonc = `{
  // Keep my preferred theme.
  "theme": "user-theme",
  "provider": {
    /* This provider is already configured. */
    "opper": {
      "options": { "baseURL": "https://gateway.example.test/v3/compat", },
      "models": { "custom/model": { "name": "User model", }, },
    },
    "other": { "name": "Other provider", },
  },
}\n`;
        writeFileSync(configPath, jsonc);
        // Even a successful catalog response must never be requested for this
        // no-op, or a strict-JSON parse failure could silently replace JSONC.
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

        await expect(editorsOpenCodeCommand({
          location,
          overwrite: false,
        })).resolves.toBeUndefined();

        expect.soft(fetchMock).not.toHaveBeenCalled();
        expect.soft(logs).toEqual([
          `OpenCode config at ${configPath} already has an Opper provider. Pass --overwrite to replace it.`,
        ]);
        expect.soft(readFileSync(configPath, "utf8")).toBe(jsonc);
      });
    });
  }
});
