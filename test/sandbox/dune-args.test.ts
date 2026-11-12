import { expect, it } from "vitest";
import { parseDuneArgs } from "../../src/sandbox/dune-args.js";
it("stops interpreting options at the executable and preserves literal arguments", () => {
  const result = parseDuneArgs([
    "--allow-domain",
    "github.com",
    "--env=TOKEN",
    "python",
    "file.py",
    "--help",
    "$(touch nope)",
    "--allow-domain",
    "literal",
  ]);
  expect(result.command).toEqual([
    "python",
    "file.py",
    "--help",
    "$(touch nope)",
    "--allow-domain",
    "literal",
  ]);
  expect(result.options).toEqual({
    domains: ["github.com"],
    env: ["TOKEN"],
    write: [],
  });
});
it("supports the delimiter and keeps observer dispatch unambiguous", () => {
  expect(parseDuneArgs(["--", "observe"]).mode).toBe("run");
  expect(parseDuneArgs(["observe"]).mode).toBe("observe");
  expect(
    parseDuneArgs(["opper", "launch", "--model", "model", "pi"]).command,
  ).toEqual(["opper", "launch", "--model", "model", "pi"]);
});
it.each([["--unknown"], ["--allow-domain"], ["--env", "KEY=value"]])(
  "rejects invalid launcher options %j",
  (...args) => {
    expect(() => parseDuneArgs(args)).toThrow();
  },
);
it("takes the network switches without a value", () => {
  const result = parseDuneArgs(["--strict", "--log-urls", "curl", "--strict"]);
  expect(result.options).toMatchObject({ strict: true, logUrls: true });
  expect(result.command).toEqual(["curl", "--strict"]);
  expect(parseDuneArgs(["curl"]).options.strict).toBeUndefined();
});
