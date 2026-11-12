import { expect, it } from "vitest";
import { parseProcesses } from "../../src/sandbox/processes.js";
import { matchesDomain } from "../../src/sandbox/srt.js";

it("reads ps rows, keeping spaces in the program path", () => {
  expect(
    parseProcesses(
      "  101     1   101 /bin/sh\n  102   101   101 /Applications/My App/tool\nnoise\n",
    ),
  ).toEqual([
    { pid: 101, parent: 1, group: 101, name: "/bin/sh" },
    { pid: 102, parent: 101, group: 101, name: "/Applications/My App/tool" },
  ]);
});

it("matches allowlist entries the way the sandbox runtime does", () => {
  expect(matchesDomain("API.example.com", "api.example.com")).toBe(true);
  expect(matchesDomain("a.example.com", "*.example.com")).toBe(true);
  expect(matchesDomain("example.com", "*.example.com")).toBe(false);
  expect(matchesDomain("badexample.com", "*.example.com")).toBe(false);
  expect(matchesDomain("example.com", "example.com:443", 443)).toBe(true);
  expect(matchesDomain("example.com", "example.com:443", 80)).toBe(false);
  expect(matchesDomain("example.com.evil.test", "example.com")).toBe(false);
  expect(matchesDomain("::ffff:1.2.3.4%x.example.com", "*.example.com")).toBe(
    false,
  );
});
