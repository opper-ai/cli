// Opper brand colors. Source: @opperai/setup src/index.ts.
// Using inline truecolor ANSI so we don't need to extend kleur.

function wrap(open: string, close = "\x1b[0m"): (s: string) => string {
  return (s: string) => {
    if (process.env.NO_COLOR) return s;
    return `${open}${s}${close}`;
  };
}

export const brand = {
  purple: wrap("\x1b[38;2;60;60;175m"),    // Savoy Purple #3C3CAF
  water: wrap("\x1b[38;2;140;240;220m"),   // Water Leaf #8CF0DC
  navy: wrap("\x1b[38;2;27;46;64m"),       // Blue Whale #1B2E40
  dim: wrap("\x1b[2m"),
  bold: wrap("\x1b[1m"),
};

/** Cotton-candy gradient endpoints sampled from the brand sheet. */
export const COTTON_CANDY = {
  start: [245, 191, 165] as const, // peach left
  end: [91, 193, 203] as const,    // teal right
};

function supportsTruecolor(): boolean {
  if (process.env.NO_COLOR) return false;
  const ct = process.env.COLORTERM ?? "";
  return ct === "truecolor" || ct === "24bit";
}

/**
 * Render `text` with a per-character truecolor gradient between two
 * endpoint colors. Falls back to a single brand colour when the terminal
 * doesn't advertise truecolor (so old 256-colour terms stay legible).
 */
export function gradient(
  text: string,
  start: readonly [number, number, number],
  end: readonly [number, number, number],
): string {
  if (process.env.NO_COLOR) return text;
  if (!supportsTruecolor()) return brand.purple(text);

  const chars = [...text];
  const n = chars.length;
  if (n === 0) return text;

  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    const r = Math.round(start[0] + (end[0] - start[0]) * t);
    const g = Math.round(start[1] + (end[1] - start[1]) * t);
    const b = Math.round(start[2] + (end[2] - start[2]) * t);
    out.push(`\x1b[38;2;${r};${g};${b}m${chars[i]}`);
  }
  out.push("\x1b[0m");
  return out.join("");
}
