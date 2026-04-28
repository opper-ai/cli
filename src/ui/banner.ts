import { brand, gradient, COTTON_CANDY } from "./colors.js";

// Block-letter OPPER wordmark. Each row is painted with the same horizontal
// peach→teal cotton-candy gradient so the color bands line up vertically
// across rows. Falls back to brand purple on terminals that don't advertise
// truecolor (or when NO_COLOR is set).
const LOGO = [
  " ██████╗ ██████╗ ██████╗ ███████╗██████╗ ",
  "██╔═══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗",
  "██║   ██║██████╔╝██████╔╝█████╗  ██████╔╝",
  "██║   ██║██╔═══╝ ██╔═══╝ ██╔══╝  ██╔══██╗",
  "╚██████╔╝██║     ██║     ███████╗██║  ██║",
  " ╚═════╝ ╚═╝     ╚═╝     ╚══════╝╚═╝  ╚═╝",
];

const TAGLINE = "the unified Opper CLI";
const INDENT = "    ";

export function printBanner(version?: string): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write("\n");
  for (const line of LOGO) {
    process.stdout.write(
      INDENT + gradient(line, COTTON_CANDY.start, COTTON_CANDY.end) + "\n",
    );
  }
  const versionSuffix = version ? `  ${brand.dim(`v${version}`)}` : "";
  process.stdout.write(INDENT + brand.accent(TAGLINE) + versionSuffix + "\n\n");
}
