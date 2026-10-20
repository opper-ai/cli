import { OpperError } from "../errors.js";

export type ModelKinds = "pools,routes" | "all";

export interface CatalogSelection {
  modelKinds?: ModelKinds;
  /** Previously configured IDs that remain in the caller's authorized catalog. */
  preserveIds?: readonly string[];
  selectedModel?: string;
}

export function validateModelKinds(value: unknown): asserts value is ModelKinds {
  if (value !== "pools,routes" && value !== "all") {
    throw new OpperError("INVALID_ARGUMENT", "--model-kinds must be pools,routes or all.");
  }
}

type CatalogEntry = { id: string; opper?: { kind?: string | undefined } | undefined };

function kind(entry: CatalogEntry): string {
  // Metadata is authoritative: a namespaced pool remains a pool, and even a
  // bare ID marked `model` is a deployment. Older gateways without kind
  // metadata used providerless pool IDs and dynamic/<name> route IDs.
  if (entry.opper?.kind !== undefined) return entry.opper.kind;
  if (entry.id.startsWith("dynamic/")) return "dynamic_route";
  return entry.id.includes("/") ? "model" : "pool";
}

function rank(entry: CatalogEntry): number {
  const value = kind(entry);
  return value === "dynamic_route" ? 0 : value === "pool" ? 1 : 2;
}

/**
 * Select picker entries after credential and adapter capability gating.
 * Preservation never creates IDs: selected/saved deployments must still be
 * present in the caller's authorized entries. Input metadata and exact IDs
 * remain untouched; ordering is stable within each kind.
 */
export function selectCatalogEntries<T extends CatalogEntry>(
  entries: T[], options: CatalogSelection,
): T[] {
  const modelKinds = options.modelKinds ?? "pools,routes";
  validateModelKinds(modelKinds);
  const preserved = new Set(options.preserveIds);
  if (options.selectedModel !== undefined) preserved.add(options.selectedModel);
  return entries.filter(entry => {
    const value = kind(entry);
    return modelKinds === "all" || preserved.has(entry.id) || value === "pool" || value === "dynamic_route";
  }).sort((left, right) => {
    const leftSelected = left.id === options.selectedModel;
    const rightSelected = right.id === options.selectedModel;
    if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
    return rank(left) - rank(right);
  });
}
