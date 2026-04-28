import { spawn } from "node:child_process";

/**
 * Best-effort: open `url` in the user's default browser. Detached child,
 * silent failure — the caller is expected to also display the URL so users
 * can paste it manually if this fails (no DISPLAY, locked-down sandbox,
 * BROWSER env unset, etc.).
 */
export function openBrowser(url: string): void {
  let cmd: string;
  let args: string[];
  if (process.platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (process.platform === "win32") {
    cmd = "cmd";
    // The empty "" is the window title — required when the URL has spaces
    // or special chars.
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(cmd, args, {
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
