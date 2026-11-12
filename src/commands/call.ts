import { OpperError } from "../errors.js";

/** Keep old scripts from silently interpreting function arguments as prompts. */
export function callCommand(): never {
  throw new OpperError("INVALID_ARGUMENT", "`opper call` has been retired. Use `opper chat` instead.",
    'Example: opper chat "your input" --system "your instructions" -m <model>. Function names are no longer required.');
}
