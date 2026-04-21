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
