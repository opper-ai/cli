import { listAdapters } from "../agents/registry.js";
import { isLaunchable } from "../agents/types.js";
import { brand } from "../ui/colors.js";

interface Row {
  name: string;
  displayName: string;
  launchable: boolean;
  installed: boolean;
  version?: string;
  configured: boolean;
}

export async function agentsListCommand(): Promise<void> {
  const rows: Row[] = await Promise.all(
    listAdapters().map(async (adapter) => {
      const [detect, configured] = await Promise.all([
        adapter.detect(),
        adapter.isConfigured(),
      ]);
      const row: Row = {
        name: adapter.name,
        displayName: adapter.displayName,
        launchable: isLaunchable(adapter),
        installed: detect.installed,
        configured,
      };
      if (detect.version) row.version = detect.version;
      return row;
    }),
  );

  const stateLabel = (r: Row) =>
    r.installed
      ? `installed${r.version ? ` v${r.version}` : ""}`
      : "not installed";
  const configLabel = (r: Row) => (r.configured ? "configured" : "not configured");
  const kindLabel = (r: Row) => (r.launchable ? "launchable" : "editor");
  const launchLabel = (r: Row) =>
    r.launchable
      ? `opper launch ${r.name}`
      : `opper editors ${r.name}`;

  // Compute widths from uncoloured strings; apply colour after padEnd.
  const w = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    display: Math.max(7, ...rows.map((r) => r.displayName.length)),
    kind: Math.max(4, ...rows.map((r) => kindLabel(r).length)),
    state: Math.max(5, ...rows.map((r) => stateLabel(r).length)),
    config: Math.max(6, ...rows.map((r) => configLabel(r).length)),
  };

  console.log(
    brand.dim(
      [
        "NAME".padEnd(w.name),
        "DISPLAY".padEnd(w.display),
        "KIND".padEnd(w.kind),
        "STATE".padEnd(w.state),
        "CONFIG".padEnd(w.config),
        "COMMAND",
      ].join("  "),
    ),
  );

  for (const r of rows) {
    const state = r.installed
      ? brand.water(stateLabel(r).padEnd(w.state))
      : brand.dim(stateLabel(r).padEnd(w.state));
    const config = r.configured
      ? brand.water(configLabel(r).padEnd(w.config))
      : brand.dim(configLabel(r).padEnd(w.config));
    const command = r.installed && r.configured
      ? launchLabel(r)
      : brand.dim(launchLabel(r));
    console.log(
      [
        r.name.padEnd(w.name),
        r.displayName.padEnd(w.display),
        brand.dim(kindLabel(r).padEnd(w.kind)),
        state,
        config,
        command,
      ].join("  "),
    );
  }
}
