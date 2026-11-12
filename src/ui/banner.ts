import { brand } from "./colors.js";

export function printBanner(version?: string): void {
  if (!process.stdout.isTTY) return;
  const versionSuffix = version ? `  ${brand.dim(`v${version}`)}` : "";
  process.stdout.write(`\n    ${brand.accent("Opper CLI")}${versionSuffix}\n\n`);
}
