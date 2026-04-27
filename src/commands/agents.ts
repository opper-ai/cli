import { listAdapters } from "../agents/registry.js";
import { brand } from "../ui/colors.js";

export async function agentsListCommand(): Promise<void> {
  for (const adapter of listAdapters()) {
    const [detect, configured] = await Promise.all([
      adapter.detect(),
      adapter.isConfigured(),
    ]);
    const installState = detect.installed
      ? `${brand.purple("installed")}${detect.version ? ` v${detect.version}` : ""}`
      : brand.dim("not installed");
    const configState = configured
      ? brand.purple("configured")
      : brand.dim("not configured");
    const kind = adapter.launchable
      ? brand.dim("[launchable]")
      : brand.dim("[editor]   ");
    console.log(
      `${adapter.displayName.padEnd(16)} ${kind}  ${installState.padEnd(20)}  ${configState}`,
    );
  }
}
