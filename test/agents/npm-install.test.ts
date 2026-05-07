import { describe, it, expect, vi, beforeEach } from "vitest";

const whichMock = vi.fn();
vi.mock("../../src/util/which.js", () => ({ which: whichMock }));

const runMock = vi.fn();
vi.mock("../../src/util/run.js", () => ({ run: runMock }));

const { npmInstallGlobal } = await import("../../src/agents/npm-install.js");

describe("npmInstallGlobal", () => {
  beforeEach(() => {
    whichMock.mockReset();
    runMock.mockReset();
  });

  it("invokes npm with `install -g <pkg>` and inherited stdio", async () => {
    whichMock.mockResolvedValue("/usr/bin/npm");
    runMock.mockReturnValue({ code: 0, stdout: "", stderr: "" });

    await expect(
      npmInstallGlobal("some-pkg", "https://example.test"),
    ).resolves.toBeUndefined();

    const [cmd, args, opts] = runMock.mock.calls[0]!;
    // Cross-platform: helper picks npm.cmd on Windows, npm elsewhere.
    expect(cmd).toMatch(/^npm(\.cmd)?$/);
    expect(args).toEqual(["install", "-g", "some-pkg"]);
    expect(opts).toMatchObject({ inherit: true });
  });

  it("throws AGENT_NOT_FOUND with a Node.js install hint when npm isn't on PATH", async () => {
    whichMock.mockResolvedValue(null);

    await expect(
      npmInstallGlobal("some-pkg", "https://example.test"),
    ).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
      message: expect.stringContaining("npm is required"),
    });
    // Bailed out before invoking npm.
    expect(runMock).not.toHaveBeenCalled();
  });

  it("throws a graceful 'interrupted' error when code is -1 with empty stderr (signal kill)", async () => {
    whichMock.mockResolvedValue("/usr/bin/npm");
    runMock.mockReturnValue({ code: -1, stdout: "", stderr: "" });

    await expect(
      npmInstallGlobal("some-pkg", "https://example.test"),
    ).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
      message: expect.stringContaining("interrupted"),
    });
  });

  it("surfaces the spawn error when code is -1 with stderr (e.g. EACCES on npm)", async () => {
    whichMock.mockResolvedValue("/usr/bin/npm");
    runMock.mockReturnValue({
      code: -1,
      stdout: "",
      stderr: "EACCES: permission denied",
    });

    await expect(
      npmInstallGlobal("some-pkg", "https://example.test"),
    ).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
      message: expect.stringContaining("EACCES: permission denied"),
    });
  });

  it("throws AGENT_NOT_FOUND with the exit code when npm exits non-zero", async () => {
    whichMock.mockResolvedValue("/usr/bin/npm");
    runMock.mockReturnValue({ code: 13, stdout: "", stderr: "" });

    await expect(
      npmInstallGlobal("some-pkg", "https://example.test"),
    ).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
      message: expect.stringContaining("exited with code 13"),
    });
  });
});
