import { spawn } from "node:child_process";
import { win32 } from "node:path";

/** Local tickets have a fixed, shell-free URL shape; OAuth keeps the Windows manual fallback. */
export function openLocalProxyBrowser(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash || !/^\/open\/[a-f0-9]{48}$/.test(url.pathname)) throw new Error("Expected a local proxy session-picker ticket.");
  if (process.platform !== "win32") {openBrowser(url.href); return;}
  try {
    const child = spawn(win32.join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows", "explorer.exe"), [url.href], {stdio:"ignore",detached:true});
    child.on("error", () => {}); child.unref();
  } catch { /* The printed one-use URL remains available for manual opening. */ }
}

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
