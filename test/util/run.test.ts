import { describe, it, expect } from "vitest";
import { run } from "../../src/util/run.js";

describe("run", () => {
  it("captures stdout and exit code", () => {
    const result = run("node", ["-e", "process.stdout.write('hi');process.exit(0)"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hi");
  });

  it("reports non-zero exit codes", () => {
    const result = run("node", ["-e", "process.exit(3)"]);
    expect(result.code).toBe(3);
  });

  it("returns code -1 when the binary is missing", () => {
    const result = run("this-does-not-exist-12345", []);
    expect(result.code).toBe(-1);
  });
});
