import { OpperError } from "../errors.js";

/** Reapprove a rejected saved login once, before any agent process starts. */
export async function withLoginRecovery<T>(
  launch: () => Promise<T>,
  authenticate: () => Promise<void>,
  interactive = Boolean(process.stdin.isTTY),
): Promise<T> {
  try { return await launch(); }
  catch (error) {
    if (!error || typeof error !== "object" || !("status" in error) || error.status !== 401) throw error;
    if (!interactive) throw new OpperError("AUTH_REQUIRED", "Opper rejected the saved login.", "Run `opper login --force` (with the same --key slot), then launch again.");
    console.error("Your saved Opper login was rejected. Sign in again to continue.");
    await authenticate();
    return launch(); // No loop if the newly approved credential is also rejected.
  }
}
