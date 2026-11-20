import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPolicy,
  changePolicy,
  applyPolicy,
  validateHost,
} from "../../scripts/sandbox-policy/policy.mjs";
const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
it("publishes immutable versions, rejects stale writes, and returns to launch defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "dune-policy-test-"));
  roots.push(root);
  expect(readPolicy(root).version).toBe(0);
  const deny = changePolicy(0, "EXAMPLE.COM", "deny", root);
  expect(
    applyPolicy({ allowedDomains: ["example.com"], deniedDomains: [] }, deny),
  ).toEqual({ allowedDomains: [], deniedDomains: ["example.com"] });
  expect(() => changePolicy(0, "other.com", "allow", root)).toThrow(/changed/);
  const allow = changePolicy(1, "example.com", "allow", root);
  expect(
    applyPolicy({ allowedDomains: [], deniedDomains: ["example.com"] }, allow)
      .deniedDomains,
  ).toEqual(["example.com"]);
  expect(JSON.parse(readFileSync(join(root, "v1.json"), "utf8"))).toEqual(deny);
  expect(changePolicy(2, "example.com", "inherit", root).rules).toEqual({});
});
it.each([
  "https://example.com",
  "example.com:443",
  "*.com",
  "a\nb.com",
  "__proto__",
  "",
  "/tmp",
])("rejects invalid destination %s", (host) =>
  expect(() => validateHost(host)).toThrow(),
);
it.each(["127.0.0.1", "::1", "example.com"])("accepts exact host %s", (host) =>
  expect(validateHost(host)).toBe(host),
);
