import { brand } from "./colors.js";

// Block-letter OPPER logo. Rendered in Opper purple at startup before the
// main menu. Suppressed when stdout is not a TTY (so test runners and
// piped invocations stay silent).
const LOGO = [
  " ██████╗ ██████╗ ██████╗ ███████╗██████╗ ",
  "██╔═══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗",
  "██║   ██║██████╔╝██████╔╝█████╗  ██████╔╝",
  "██║   ██║██╔═══╝ ██╔═══╝ ██╔══╝  ██╔══██╗",
  "╚██████╔╝██║     ██║     ███████╗██║  ██║",
  " ╚═════╝ ╚═╝     ╚═╝     ╚══════╝╚═╝  ╚═╝",
];

const TAGLINE = "  the unified Opper CLI";

export function printBanner(version?: string): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write("\n");
  for (const line of LOGO) {
    process.stdout.write(brand.purple(line) + "\n");
  }
  const versionSuffix = version ? `  ${brand.dim(`v${version}`)}` : "";
  process.stdout.write(brand.water(TAGLINE) + versionSuffix + "\n\n");
}
