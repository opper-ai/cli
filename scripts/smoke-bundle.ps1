# Smoke-test a Windows bundle in a path containing spaces, without Node/npm/npx
# on PATH. Runs on Windows PowerShell/PowerShell without symlink privileges.
param([Parameter(Mandatory = $true)][string]$Tarball)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$repo = Split-Path $PSScriptRoot -Parent
$expected = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$archive = (Resolve-Path $Tarball).Path
$tar = Join-Path $env:SystemRoot 'System32/tar.exe'
if (!(Test-Path $tar -PathType Leaf)) { throw 'Windows system tar.exe is required to extract the ZIP bundle' }
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("opper bundle smoke " + [guid]::NewGuid())
$savedEnvironment = @{}
foreach ($entry in Get-ChildItem Env:) { $savedEnvironment[$entry.Name] = $entry.Value }

function Invoke-Bundle {
  param([string]$Command, [string[]]$CliArgs, [int]$ExpectedCode = 0)
  # Native stderr is expected for negative paths; inspect the exit code and
  # captured output explicitly instead of treating stderr as a script error.
  $ErrorActionPreference = 'Continue'
  $output = & $Command @CliArgs 2>&1
  $rc = $LASTEXITCODE
  $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
  if ($rc -ne $ExpectedCode) {
    throw "${Command} exited $rc, expected ${ExpectedCode}: $text"
  }
  return $text
}

try {
  New-Item -ItemType Directory -Path $work | Out-Null
  & $tar -xf $archive -C $work
  if ($LASTEXITCODE -ne 0) { throw 'Failed to extract bundle' }
  $roots = @(Get-ChildItem $work -Directory)
  if ($roots.Count -ne 1) { throw 'Bundle must contain one top-level directory' }
  $root = $roots[0].FullName
  $launcher = Join-Path $root 'bin/opper.cmd'
  if (!(Test-Path $launcher -PathType Leaf) -or !(Test-Path (Join-Path $root 'lib/node.exe') -PathType Leaf)) {
    throw 'Bundle layout is wrong'
  }
  $smokeHome = Join-Path $work 'home'
  New-Item -ItemType Directory -Path $smokeHome | Out-Null

  # Keep the Windows process essentials; discard user keys, login state,
  # NODE_OPTIONS, and agent home overrides before running the actual bundle.
  $systemRoot = $env:SystemRoot
  foreach ($entry in @(Get-ChildItem Env:)) {
    [Environment]::SetEnvironmentVariable($entry.Name, $null, 'Process')
  }
  $isolated = @{
    SystemRoot = $systemRoot
    WINDIR = $systemRoot
    COMSPEC = Join-Path $systemRoot 'System32/cmd.exe'
    PATH = (Join-Path $root 'bin') + ';' + (Join-Path $systemRoot 'System32')
    PATHEXT = '.COM;.EXE;.BAT;.CMD'
    HOME = $smokeHome
    USERPROFILE = $smokeHome
    APPDATA = Join-Path $smokeHome 'AppData/Roaming'
    LOCALAPPDATA = Join-Path $smokeHome 'AppData/Local'
    OPPER_HOME = Join-Path $smokeHome '.opper'
    OPPER_EDITOR_HOME = $smokeHome
    CODEX_HOME = Join-Path $smokeHome '.codex'
    HERMES_HOME = Join-Path $smokeHome '.hermes'
    XDG_CONFIG_HOME = Join-Path $smokeHome '.config'
    XDG_CACHE_HOME = Join-Path $smokeHome '.cache'
    TEMP = $work
    TMP = $work
    CI = '1'
    NO_COLOR = '1'
    NO_UPDATE_NOTIFIER = '1'
  }
  foreach ($key in $isolated.Keys) {
    [Environment]::SetEnvironmentVariable($key, $isolated[$key], 'Process')
  }
  foreach ($command in 'node', 'npm', 'npx') {
    if (Get-Command $command -CommandType Application -ErrorAction SilentlyContinue) {
      throw "Unexpected $command on smoke-test PATH"
    }
  }

  $version = Invoke-Bundle -Command $launcher -CliArgs @('--version')
  if ($version -ne $expected) { throw "Direct launch printed '$version', expected '$expected'" }
  $version = Invoke-Bundle -Command 'opper' -CliArgs @('--version')
  if ($version -ne $expected) { throw "PATH launch printed '$version', expected '$expected'" }
  Invoke-Bundle -Command 'opper' -CliArgs @('--help') | Out-Null
  $agents = Invoke-Bundle -Command 'opper' -CliArgs @('agents', 'list')
  if (!$agents.Contains('opper launch claude')) { throw 'Agents list did not mention claude' }
  $failure = Invoke-Bundle -Command 'opper' -CliArgs @('--key', 'bundle smoke missing', 'whoami') -ExpectedCode 2
  if (!$failure.Contains('No API key stored for slot "bundle smoke missing"')) {
    throw "Launcher did not preserve arguments: $failure"
  }
  Write-Host "ok: $(Split-Path $archive -Leaf) runs $expected with its bundled Node"
}
finally {
  foreach ($entry in @(Get-ChildItem Env:)) {
    [Environment]::SetEnvironmentVariable($entry.Name, $null, 'Process')
  }
  foreach ($key in $savedEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], 'Process')
  }
  if (Test-Path $work) { Remove-Item $work -Recurse -Force }
}

# The last native command intentionally exited 2 in the negative test. Report
# success after cleanup so GitHub's pwsh wrapper does not reuse that exit code.
exit 0
