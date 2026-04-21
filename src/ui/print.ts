import { OpperError } from "../errors.js";
import { brand } from "./colors.js";

export function printError(err: unknown): void {
  if (err instanceof OpperError) {
    process.stderr.write(`${brand.bold("error")} [${err.code}]: ${err.message}\n`);
    if (err.hint) {
      process.stderr.write(`  ${brand.dim("hint:")} ${err.hint}\n`);
    }
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${brand.bold("error")}: ${msg}\n`);
}
