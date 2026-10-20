import { describe, expect, it } from "vitest";
import { OpperError } from "../../src/errors.js";
import { selectCatalogEntries, validateModelKinds } from "../../src/setup/model-catalog.js";

interface Entry { id: string; opper?: { kind?: string | undefined } | undefined; marker?: string }
const ids = (entries: Entry[]) => entries.map(entry => entry.id);
const entries: Entry[] = [
  { id: "vendor/deployment", opper: { kind: "model" } },
  { id: "pool/namespaced", opper: { kind: "pool" } },
  { id: "bare-deployment", opper: { kind: "model" } },
  { id: "opaque-route", opper: { kind: "dynamic_route" } },
  { id: "preferred-pool", opper: { kind: "pool" } },
  { id: "dynamic/route", opper: { kind: "dynamic_route" } },
];

describe("shared model catalog selection", () => {
  it("defaults to authoritative pools/routes with stable route then pool ordering", () => {
    expect(ids(selectCatalogEntries(entries, {}))).toEqual([
      "opaque-route", "dynamic/route", "pool/namespaced", "preferred-pool",
    ]);
  });

  it("preserves exact selected and saved deployment IDs without widening authorization", () => {
    expect(ids(selectCatalogEntries(entries, {
      selectedModel: "vendor/deployment",
      preserveIds: ["bare-deployment", "missing", "vendor/other"],
    }))).toEqual([
      "vendor/deployment", "opaque-route", "dynamic/route", "pool/namespaced", "preferred-pool", "bare-deployment",
    ]);
    expect(ids(selectCatalogEntries(entries, { selectedModel: "missing" }))).not.toContain("missing");
  });

  it("moves a selected pool to the front while preserving gateway order within kinds", () => {
    expect(ids(selectCatalogEntries(entries, { selectedModel: "preferred-pool" }))).toEqual([
      "preferred-pool", "opaque-route", "dynamic/route", "pool/namespaced",
    ]);
  });

  it("includes deployments explicitly and supports narrowing and widening without changing input", () => {
    const snapshot = structuredClone(entries);
    const all = selectCatalogEntries(entries, { modelKinds: "all" });
    expect(ids(all)).toEqual([
      "opaque-route", "dynamic/route", "pool/namespaced", "preferred-pool", "vendor/deployment", "bare-deployment",
    ]);
    expect(selectCatalogEntries(entries, { modelKinds: "pools,routes" })).toHaveLength(4);
    expect(selectCatalogEntries(entries, { modelKinds: "all" })).toEqual(all);
    expect(entries).toEqual(snapshot);
    expect(all.find(entry => entry.id === "vendor/deployment")).toBe(entries[0]);
  });

  it("uses legacy ID inference only when kind metadata is absent", () => {
    const legacy: Entry[] = [
      { id: "vendor/legacy" }, { id: "bare-legacy", marker: "keep metadata" },
      { id: "dynamic/legacy" }, { id: "dynamic/model", opper: { kind: "model" } },
      { id: "unknown-bare", opper: { kind: "future-kind" } },
      { id: "empty-metadata", opper: {} },
      { id: "undefined-metadata", opper: undefined },
      { id: "undefined-kind", opper: { kind: undefined } },
    ];
    const selected = selectCatalogEntries(legacy, {});
    expect(ids(selected)).toEqual(["dynamic/legacy", "bare-legacy", "empty-metadata", "undefined-metadata", "undefined-kind"]);
    expect(selected[1]!.marker).toBe("keep metadata");
  });

  it("returns no unauthorized fallback when only deployments or no entries remain", () => {
    expect(selectCatalogEntries([entries[0]!], {})).toEqual([]);
    expect(selectCatalogEntries([], { modelKinds: "all", selectedModel: "missing" })).toEqual([]);
  });

  it("accepts exactly the supported catalog policies and rejects invalid runtime values", () => {
    expect(() => validateModelKinds("all")).not.toThrow();
    expect(() => validateModelKinds("pools,routes")).not.toThrow();
    for (const value of [undefined, null, "", "models", "all ", [], 1]) {
      expect(() => validateModelKinds(value)).toThrow(OpperError);
      expect(() => validateModelKinds(value)).toThrow(/model-kinds/);
    }
    expect(() => selectCatalogEntries(entries, { modelKinds: "models" as "all" })).toThrow(/model-kinds/);
  });
});
