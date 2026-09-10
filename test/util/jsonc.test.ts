import { describe, expect, it } from "vitest";
import { deleteJsoncProperty, parseJsoncObject } from "../../src/util/jsonc.js";

describe("deleteJsoncProperty", () => {
  const original = `{
  // Before first
  "first": 1, // After first
  // Before middle
  "middle": 2, // After middle
  // Before last
  "last": 3, // After last
}\n`;

  it.each(["first", "middle", "last"])("deletes the %s property while preserving sibling comments", (key) => {
    const text = deleteJsoncProperty(original, [key]);
    const expected = { first: 1, middle: 2, last: 3 } as Record<string, number>;
    delete expected[key];
    expect(parseJsoncObject(text)).toEqual(expected);
    for (const comment of ["Before first", "After first", "Before middle", "After middle", "Before last", "After last"]) {
      expect(text).toContain(`// ${comment}`);
    }
  });

  it("removes a sole property's trailing comma and leaves surrounding comments", () => {
    const text = deleteJsoncProperty('{/* keep */ "only": 1, /* also keep */}', ["only"]);
    expect(parseJsoncObject(text)).toEqual({});
    expect(text).toContain("/* keep */");
    expect(text).toContain("/* also keep */");
  });

  it("does not introduce missing intermediate objects", () => {
    expect(deleteJsoncProperty(original, ["missing", "child"])).toBe(original);
  });

  it("deletes a nested property without removing a neighboring provider", () => {
    const text = deleteJsoncProperty('{"provider":{"opper":{}, /* keep other */ "other":{}}}', ["provider", "opper"]);
    expect(parseJsoncObject(text)).toEqual({ provider: { other: {} } });
    expect(text).toContain("/* keep other */");
  });
});
