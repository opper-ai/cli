import { describe, it, expect, vi } from "vitest";

const whichMock = vi.fn();
const runMock = vi.fn();

vi.mock("../../src/util/which.js", () => ({ which: whichMock }));
vi.mock("../../src/util/run.js", () => ({ run: runMock }));

const { hermes } = await import("../../src/agents/hermes.js");

describe("hermes adapter — detect", () => {
  it("returns installed=false when `which hermes` returns null", async () => {
    whichMock.mockResolvedValue(null);
    const result = await hermes.detect();
    expect(result.installed).toBe(false);
    expect(result.version).toBeUndefined();
  });

  it("returns installed=true with version when hermes is on PATH", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/hermes");
    runMock.mockReturnValue({
      code: 0,
      stdout: "hermes 1.2.3\n",
      stderr: "",
    });
    const result = await hermes.detect();
    expect(result.installed).toBe(true);
    expect(result.version).toBe("1.2.3");
    expect(result.configPath).toMatch(/\.hermes\/config\.yaml$/);
  });

  it("returns installed=true with undefined version when --version fails", async () => {
    whichMock.mockResolvedValue("/usr/local/bin/hermes");
    runMock.mockReturnValue({ code: 1, stdout: "", stderr: "boom" });
    const result = await hermes.detect();
    expect(result.installed).toBe(true);
    expect(result.version).toBeUndefined();
  });
});

describe("hermes adapter — metadata", () => {
  it("has the expected name, displayName, binary, docsUrl", () => {
    expect(hermes.name).toBe("hermes");
    expect(hermes.displayName).toBe("Hermes Agent");
    expect(hermes.binary).toBe("hermes");
    expect(hermes.docsUrl).toBe("https://hermes-agent.nousresearch.com/docs/");
  });
});
