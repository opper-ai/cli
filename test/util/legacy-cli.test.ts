import { describe, it, expect, vi, beforeEach } from "vitest";

const runMock = vi.fn();
vi.mock("../../src/util/run.js", () => ({ run: runMock }));

const { detectLegacyOpperCli } = await import("../../src/util/legacy-cli.js");

describe("detectLegacyOpperCli", () => {
  beforeEach(() => {
    runMock.mockReset();
  });

  it("returns null when `which -a` exits non-zero (no opper on PATH)", () => {
    runMock.mockReturnValue({ code: 1, stdout: "", stderr: "" });
    expect(detectLegacyOpperCli()).toBeNull();
  });

  it("returns null when only the npm-installed opper is on PATH", () => {
    runMock.mockReturnValue({
      code: 0,
      stdout: "/Users/me/.nvm/versions/node/v20.10.0/bin/opper\n",
      stderr: "",
    });
    expect(detectLegacyOpperCli()).toBeNull();
  });

  it("flags shadowsUs=true when the brew formula is first on PATH", () => {
    // We can't symlink-resolve in a unit test, but the substring match
    // works on the raw path too — Cellar entries contain /Cellar/opper/
    // even before realpath resolution.
    runMock.mockReturnValue({
      code: 0,
      stdout: [
        "/opt/homebrew/Cellar/opper/0.13.0/bin/opper",
        "/Users/me/.nvm/versions/node/v20.10.0/bin/opper",
      ].join("\n"),
      stderr: "",
    });
    const result = detectLegacyOpperCli();
    expect(result?.path).toMatch(/\/Cellar\/opper\/0\.13\.0\/bin\/opper$/);
    expect(result?.shadowsUs).toBe(true);
  });

  it("flags shadowsUs=false when the brew formula appears after our binary", () => {
    runMock.mockReturnValue({
      code: 0,
      stdout: [
        "/Users/me/.nvm/versions/node/v20.10.0/bin/opper",
        "/usr/local/Cellar/opper/0.13.0/bin/opper",
      ].join("\n"),
      stderr: "",
    });
    const result = detectLegacyOpperCli();
    expect(result?.shadowsUs).toBe(false);
  });
});
