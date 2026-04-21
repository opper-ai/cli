import { listAdapters } from "../agents/registry.js";
import { brand } from "../ui/colors.js";

export async function agentsListCommand(): Promise<void> {
  for (const adapter of listAdapters()) {
    const detect = await adapter.detect();
    const status = detect.installed
      ? `${brand.purple("installed")}${detect.version ? ` v${detect.version}` : ""}`
      : brand.dim("not installed");
    const config = detect.configPath ? ` ${brand.dim(detect.configPath)}` : "";
    console.log(`${adapter.displayName.padEnd(16)} ${status}${config}`);
  }
}
