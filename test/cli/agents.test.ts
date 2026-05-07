import { describe, it, expect } from "vitest";
import { collectTagPairs } from "../../src/cli/agents.js";

describe("collectTagPairs", () => {
  it("accepts a key=value pair and returns it merged into the accumulator", () => {
    const result = collectTagPairs("customer=acme", {});
    expect(result).toEqual({ customer: "acme" });
  });

  it("merges into an existing accumulator without mutating it", () => {
    const acc = { team: "eu" };
    const result = collectTagPairs("customer=acme", acc);
    expect(result).toEqual({ team: "eu", customer: "acme" });
    // The previous accumulator is left untouched (Commander relies on the
    // returned value being the new accumulator).
    expect(acc).toEqual({ team: "eu" });
  });

  it("rejects a value with no '=' separator", () => {
    expect(() => collectTagPairs("nokey", {})).toThrow(/expects key=value/);
  });

  it("rejects an empty key (=value form)", () => {
    expect(() => collectTagPairs("=value", {})).toThrow(/expects key=value/);
  });

  it("rejects the multi-pair shorthand (key=value,key=value)", () => {
    expect(() =>
      collectTagPairs("team=eu,customer=acme", {}),
    ).toThrow(/multiple pairs/);
  });

  it("preserves a plain comma inside a value", () => {
    expect(collectTagPairs("customer=Acme, Inc", {})).toEqual({
      customer: "Acme, Inc",
    });
  });

  it("rejects a duplicate key on a second call", () => {
    const acc = collectTagPairs("team=eu", {});
    expect(() => collectTagPairs("team=us", acc)).toThrow(
      /"team" specified twice/,
    );
  });

  it("preserves '=' inside the value", () => {
    const result = collectTagPairs("filter=a=b", {});
    expect(result).toEqual({ filter: "a=b" });
  });
});
