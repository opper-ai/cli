import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { win32 } from "node:path";
import { OpperError } from "../errors.js";

/** Constant Windows PowerShell 5/.NET Framework checker, also embedded in desktop auth helpers.
 * Input is JSON on stdin: {path, kind: "directory"|"file", create: boolean}.
 * No caller-controlled text is evaluated as PowerShell code. New objects receive their DACL
 * in the native creation call; existing objects are verified and never repaired.
 */
export const POWERSHELL_PRIVATE_STATE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$failureCode = 'AGENT_CONFIG_CONFLICT'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.path -isnot [string] -or !$request.path -or $request.create -isnot [bool] -or $request.kind -notin @('directory', 'file')) { throw 'Invalid request' }
  $path = [System.IO.Path]::GetFullPath($request.path)
  if ($path -notmatch '^[A-Za-z]:\\' -or $path.Substring(2).Contains(':')) { throw 'State must be a local drive path without alternate streams' }
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $noPropagation = [System.Security.AccessControl.PropagationFlags]::None

  function Assert-PathChain([string] $target) {
    $cursor = $target
    $immediateParent = [System.IO.Path]::GetDirectoryName($target)
    $trustedAncestorSids = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
    $takeoverRights = [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    while ($cursor) {
      try {
        $attributes = [System.IO.File]::GetAttributes($cursor)
        if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points are unsupported' }
        if ($cursor -ne $target -and (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0)) {
          $ancestorAcl = [System.IO.Directory]::GetAccessControl($cursor)
          if ($ancestorAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -notin $trustedAncestorSids) { throw 'An untrusted ancestor owner can change access rules' }
          $riskRights = $takeoverRights
          if ($cursor -eq $immediateParent) {
            $riskRights = $riskRights -bor [System.Security.AccessControl.FileSystemRights]::WriteData -bor [System.Security.AccessControl.FileSystemRights]::AppendData
          }
          foreach ($rule in $ancestorAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
            $inheritOnly = ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0
            if ($rule.AccessControlType -eq $allow -and !$inheritOnly -and $rule.IdentityReference.Value -notin $trustedAncestorSids -and (($rule.FileSystemRights -band $riskRights) -ne 0)) { throw 'An untrusted ancestor permits state takeover' }
          }
        }
      } catch [System.IO.FileNotFoundException] {
      } catch [System.IO.DirectoryNotFoundException] {
      }
      $parent = [System.IO.Path]::GetDirectoryName($cursor)
      if ($parent -eq $cursor) { break }
      $cursor = $parent
    }
  }
  function Assert-PrivateAcl([string] $target, [bool] $directory) {
    $attributes = [System.IO.File]::GetAttributes($target)
    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point' }
    $isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
    if ($isDirectory -ne $directory) { throw 'Wrong object type' }
    if ($directory) { $acl = [System.IO.Directory]::GetAccessControl($target) }
    else { $acl = [System.IO.File]::GetAccessControl($target) }
    if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Wrong owner SID' }
    if ($directory -and !$acl.AreAccessRulesProtected) { throw 'Directory DACL must be protected' }
    $currentFullControl = $false
    $allowedSids = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -ne $allow) { throw 'Deny ACLs are unsupported' }
      if ($rule.IdentityReference.Value -notin $allowedSids) { throw 'Another principal has access' }
      $inheritOnly = ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0
      if ($rule.IdentityReference.Value -eq $sid.Value -and !$inheritOnly -and (($rule.FileSystemRights -band $fullControl) -eq $fullControl)) { $currentFullControl = $true }
    }
    if (!$currentFullControl) { throw 'Empty, null, or insufficient DACL' }
  }
  Assert-PathChain $path
  $exists = [System.IO.Directory]::Exists($path) -or [System.IO.File]::Exists($path)
  if (!$exists -and !$request.create) { $failureCode = 'ENOENT'; throw 'Missing state' }
  if ($request.kind -eq 'file') {
    $parent = [System.IO.Path]::GetDirectoryName($path)
    Assert-PrivateAcl $parent $true
  }
  if (!$exists) {
    if ($request.kind -eq 'directory') {
      $security = New-Object System.Security.AccessControl.DirectorySecurity
      $security.SetOwner($sid)
      $security.SetAccessRuleProtection($true, $false)
      $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $fullControl, $inheritance, $noPropagation, $allow)
      $security.AddAccessRule($rule)
      $null = [System.IO.Directory]::CreateDirectory($path, $security)
    } else {
      $security = New-Object System.Security.AccessControl.FileSecurity
      $security.SetOwner($sid)
      $security.SetAccessRuleProtection($true, $false)
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $fullControl, $allow)
      $security.AddAccessRule($rule)
      $stream = [System.IO.FileStream]::new($path, [System.IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]::Modify, [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::None, $security)
      $stream.Dispose()
    }
  }
  Assert-PathChain $path
  Assert-PrivateAcl $path ($request.kind -eq 'directory')
  [Console]::Out.Write('{"ok":true}')
} catch {
  [Console]::Out.Write(('{"ok":false,"code":"' + $failureCode + '"}'))
  exit 1
}
`;

function conflict(kind: "directory" | "file"): OpperError {
  return new OpperError("AGENT_CONFIG_CONFLICT", `Local proxy state ${kind} must be private, owned by the current user, and without a symlink or junction.`);
}

async function windowsState(path: string, kind: "directory" | "file", create: boolean): Promise<void> {
  const executable = win32.join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encoded = Buffer.from(POWERSHELL_PRIVATE_STATE_SCRIPT, "utf16le").toString("base64");
  await new Promise<void>((resolve, reject) => {
    const child = execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {timeout: 15_000, maxBuffer: 16_384, windowsHide: true}, (cause, stdout) => {
      let result: {ok?: unknown; code?: unknown} | undefined;
      try {result = JSON.parse(stdout.trim()) as {ok?: unknown; code?: unknown};} catch { /* Native checker failures are always closed. */ }
      if (!cause && result?.ok === true) {resolve(); return;}
      if (result?.code === "ENOENT") {
        reject(Object.assign(new Error("No local proxy state found."), {code: "ENOENT"}));
      } else reject(conflict(kind));
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({path, kind, create}));
  });
}

/** Existing directories are checked, never chmodded or granted access automatically. */
export async function ensurePrivateStateDirectory(path: string, create = false): Promise<void> {
  if (process.platform === "win32") {
    if (!create) await lstat(path); // Preserve ENOENT without spawning PowerShell during readiness polling.
    return windowsState(path, "directory", create);
  }
  if (create) {
    try {await mkdir(path, {recursive: true, mode: 0o700});}
    catch (cause) {if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;}
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw conflict("directory");
}

/** Creates an empty private file when missing. Existing contents and ACLs are untouched. */
export async function ensurePrivateStateFile(path: string, create = false): Promise<void> {
  if (process.platform === "win32") {
    if (!create) await lstat(path);
    return windowsState(path, "file", create);
  }
  if (create) {
    try {
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await file.close();
    } catch (cause) {if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;}
  }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw conflict("file");
}

export async function assertPrivateStateFile(path: string): Promise<void> {
  return ensurePrivateStateFile(path);
}
