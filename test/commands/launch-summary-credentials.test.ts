import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSlot } from "../../src/auth/config.js";
import type { OpperRouting } from "../../src/agents/types.js";

// Use real launch orchestration, stored credentials, API client, and formatter.
// Only the agent process and its remote usage endpoint are substituted.
const adapter = vi.hoisted(() => ({
  name: "summary-test",
  displayName: "Summary Test Agent",
  docsUrl: "https://example.test",
  detect: vi.fn(),
  isConfigured: vi.fn(),
  configure: vi.fn(),
  unconfigure: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("../../src/agents/registry.js", () => ({
  getAdapter: (name: string) => name === adapter.name ? adapter : null,
  listAdapters: () => [adapter],
}));

const { launchCommand } = await import("../../src/commands/launch.js");

describe("launch session summary credentials and availability", () => {
  const selectedKey = "op_live_selected_summary_test";
  const selectedHost = "https://selected.example.test/gateway";
  const ambientKey = "op_live_ambient_summary_test";
  const rotatedKey = "op_live_rotated_summary_test";
  const changedAmbientKey = "op_live_changed_ambient_summary_test";
  const rawErrorMarker = "raw-gateway-error-must-not-be-displayed";
  const startedAt = new Date("2026-09-10T12:00:00.000Z");
  const fetchMock = vi.fn<typeof fetch>();
  let home: string;
  let output: string[];
  let routingUsed: OpperRouting | undefined;
  let duringRun: () => Promise<void>;
  let childExitCode: number;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "opper-summary-credentials-"));
    vi.stubEnv("OPPER_HOME", home);
    vi.stubEnv("OPPER_API_KEY", undefined);
    vi.stubEnv("OPPER_BASE_URL", undefined);
    await setSlot("default", {
      apiKey: "op_live_default_summary_test",
      baseUrl: "https://default.example.test",
    });
    await setSlot("team", { apiKey: selectedKey, baseUrl: selectedHost });
    // Only Date is faked: disk I/O and the mocked HTTP boundary use normal
    // scheduling, while a two-second session takes no wall-clock wait.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(startedAt);
    childExitCode = 17;
    routingUsed = undefined;
    duringRun = async () => {};
    adapter.detect.mockReset().mockResolvedValue({ installed: true });
    adapter.spawn.mockReset().mockImplementation(async (_args: string[], routing: OpperRouting) => {
      routingUsed = { ...routing };
      await duringRun();
      vi.setSystemTime(startedAt.getTime() + 2_000);
      return childExitCode;
    });
    fetchMock.mockReset().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    output = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    });
    for (const method of ["log", "error", "warn"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        output.push(args.map(String).join(" "));
      });
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function summaryText(): string {
    return output.join("").replace(/\u001b\[[0-9;]*m/g, "");
  }

  async function launch(): Promise<number> {
    return launchCommand({
      agent: adapter.name,
      key: "team",
      tags: { customer: "acme" },
    });
  }

  function expectCapturedCredentials(expectedHost: string): void {
    expect(routingUsed?.apiKey).toBe(selectedKey);
    expect(routingUsed?.apiBaseUrl).toBe(expectedHost);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(input));
    expect.soft(`${url.origin}${url.pathname}`).toBe(`${expectedHost}/v2/analytics/usage`);
    expect.soft(init?.method).toBe("GET");
    expect.soft(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${routingUsed!.apiKey}`);
    const sessionId = routingUsed!.baseUrl.match(/\/v3\/session\/([^/]+)/)?.[1];
    expect(sessionId).toMatch(/^sess_/);
    expect(url.searchParams.get("session_id")).toBe(sessionId);
    expect(url.searchParams.get("group_by")).toBe("model");
    expect(url.searchParams.get("fields")).toBe("total_tokens");
    expect(url.searchParams.has("from_date")).toBe(false);
    expect(url.searchParams.has("to_date")).toBe(false);
  }

  function expectNoSecretsOrRawErrors(text: string): void {
    for (const secret of [selectedKey, ambientKey, rotatedKey, changedAmbientKey, rawErrorMarker]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain("Authorization:");
  }

  it("uses the selected child key and overridden host for successful usage totals despite an ambient key", async () => {
    const overrideHost = "https://override.example.test/proxy";
    vi.stubEnv("OPPER_API_KEY", ambientKey);
    vi.stubEnv("OPPER_BASE_URL", overrideHost);
    fetchMock.mockResolvedValue(new Response(JSON.stringify([
      { model: "sonnet", cost: "0.01", count: 2, total_tokens: "1000" },
      { model: "sonnet", cost: "0.02", count: 1, total_tokens: "2000" },
      { model: "haiku", cost: "0.005", count: 1, total_tokens: "2000" },
    ]), { status: 200 }));

    expect(await launch()).toBe(childExitCode);

    expectCapturedCredentials(overrideHost);
    const text = summaryText();
    expect(text).toMatch(/Requests\s+4/);
    expect(text).toMatch(/Tokens\s+5,000/);
    expect(text).toMatch(/Cost\s+\$0\.0350/);
    expect(text).toMatch(/sonnet\s+3 reqs\s+3,000 tok\s+\$0\.0300/);
    expect(text).not.toMatch(/usage unavailable|usage rollup lags/i);
    expectNoSecretsOrRawErrors(text);
  });

  it.each(["stored slot", "environment and stored slot"])(
    "keeps the captured launch credentials when the %s changes during the agent run",
    async (changed) => {
      duringRun = async () => {
        await setSlot("team", {
          apiKey: rotatedKey,
          baseUrl: "https://rotated.example.test",
        });
        if (changed === "environment and stored slot") {
          vi.stubEnv("OPPER_API_KEY", changedAmbientKey);
          vi.stubEnv("OPPER_BASE_URL", "https://changed.example.test");
        }
      };

      expect(await launch()).toBe(childExitCode);

      expectCapturedCredentials(selectedHost);
      expectNoSecretsOrRawErrors(summaryText());
    },
  );

  it("reports rollup lag only for a successful response with no usage rows", async () => {
    childExitCode = 0;

    expect(await launch()).toBe(0);

    expectCapturedCredentials(selectedHost);
    const text = summaryText();
    expect(text).toContain("Session summary");
    expect(text).toMatch(/Duration\s+2s/);
    expect(text).toContain("usage rollup lags");
    expect(text).not.toMatch(/usage unavailable/i);
    expect(text).not.toMatch(/^\s*(Cost|Tokens|Requests)\s/m);
    expectNoSecretsOrRawErrors(text);
  });

  it.each([
    { failure: "HTTP 401", httpStatus: 401 },
    { failure: "HTTP 403", httpStatus: 403 },
    { failure: "HTTP 503", httpStatus: 503 },
    { failure: "a network error", httpStatus: undefined },
  ])("reports Usage unavailable after $failure without exposing errors or changing the child exit code", async ({ httpStatus }) => {
    const rawError = `${rawErrorMarker}: Authorization: Bearer ${selectedKey}`;
    if (httpStatus === undefined) {
      fetchMock.mockRejectedValue(new Error(rawError));
    } else {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: rawError } }), {
        status: httpStatus,
      }));
    }

    expect(await launch()).toBe(childExitCode);

    expectCapturedCredentials(selectedHost);
    const text = summaryText();
    expect.soft(text).toMatch(/usage unavailable/i);
    expect.soft(text).not.toContain("usage rollup lags");
    expect(text).toContain("Session summary");
    expect(text).toMatch(/Duration\s+2s/);
    expect(text).toContain("https://platform.opper.ai/traces");
    expect(text).not.toMatch(/^\s*(Cost|Tokens|Requests)\s/m);
    expectNoSecretsOrRawErrors(text);
  });
});
