import { spawn } from "node:child_process";

/**
 * Best-effort: open `url` in the user's default browser. Detached child,
 * silent failure — the caller is expected to also display the URL so users
 * can paste it manually if this fails (no DISPLAY, locked-down sandbox,
 * BROWSER env unset, etc.). Windows always uses that manual fallback rather
 * than passing an OAuth URL through a command interpreter.
 */
export function openBrowser(url: string): void {
  if (process.platform === "win32") return;
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";

  try {
    const child = spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {
      // Silent — caller still prints the URL.
    });
    child.unref();
  } catch {
    // Silent.
  }
}
