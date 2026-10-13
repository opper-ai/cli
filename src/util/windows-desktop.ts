import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { run } from "./run.js";

export interface WindowsDesktopApp { installLocation: string; executable: string; aumid: string }

export function powerShellLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

/** Query registered packages for the current user; read executable and AUMID from their manifest. */
export function windowsDesktopApps(packageName: "OpenAI.Codex" | "Claude"): WindowsDesktopApp[] {
  const script = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $items = @(); foreach ($package in @(Get-AppxPackage -Name ${powerShellLiteral(packageName)} -ErrorAction SilentlyContinue)) { $manifest = Get-AppxPackageManifest -Package $package; foreach ($application in @($manifest.Package.Applications.Application)) { if ($application.Executable) { $items += [pscustomobject]@{installLocation=$package.InstallLocation; executable=[string]$application.Executable; aumid=($package.PackageFamilyName + '!' + $application.Id)} } } }; ConvertTo-Json -InputObject @($items) -Compress`;
  const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  if (!result || result.code !== 0 || !result.stdout.trim()) return [];
  let value: unknown;
  try { value = JSON.parse(result.stdout); } catch { return []; }
  if (!Array.isArray(value)) return [];
  const apps: WindowsDesktopApp[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Partial<WindowsDesktopApp>;
    if (typeof entry.installLocation !== "string" || !entry.installLocation.trim() ||
        typeof entry.executable !== "string" || !entry.executable.trim() ||
        typeof entry.aumid !== "string" || !/^[a-zA-Z0-9._-]+![a-zA-Z0-9._-]+$/.test(entry.aumid)) continue;
    const parts = entry.executable.split(/[\\/]+/);
    if (isAbsolute(entry.executable) || /^[a-z]:|^[\\/]/i.test(entry.executable) || parts.some((part) => part === ".." || part === ".") ||
        !/^(?:Codex|ChatGPT|Claude)\.exe$/i.test(parts.at(-1) ?? "")) continue;
    const root = resolve(entry.installLocation);
    const executable = join(root, ...parts);
    const contained = relative(root, executable);
    if (!contained || contained.startsWith("..") || isAbsolute(contained) || !existsSync(executable)) continue;
    apps.push({installLocation: root, executable, aumid: entry.aumid});
  }
  return apps;
}
