<#
.SYNOPSIS
  Install (or uninstall) the dsh-chat-find plugin into the DSH desktop profile.

.DESCRIPTION
  Performs the two writes that DSH's own `plugin_manager install_bundle` would
  perform, so the plugin can be installed without the GUI:

    1. add the plugin as a profile dependency (pnpm, offline `file:` copy)
    2. add the plugin to `dsh.profile.bundles` in the profile's package.json

  WHY NOT cordis.patch.yml: a `dsh.profile.bundles` entry already applies the
  package's own `dsh.bundle.patch`, so ALSO inserting a row into the profile
  patch double-mounts the plugin. `conversation.session.header.actions` is a
  list slot, and two registrations with the same id make the host throw. This
  bit the plugin once (bug #4 in INSTALL.md) — this script now writes only the
  bundles entry.

  Both steps are backed up first and are individually reversible.

  A RESTART IS REQUIRED only on FIRST install: the client bundle is a new
  module, and HMR can only swap a generation that has already been loaded once.
  Later edits to client.js are picked up automatically — `@deepseek-ai/dsh-client-hmr`
  stat-polls each client bundle and hot-reloads a changed one in ~2 s, so after
  copying client.js into the profile's node_modules the change is live without
  a restart.

.PARAMETER Action
  install   - link the package and add the bundles entry (default)
  uninstall - remove the bundles entry and the dependency
  status    - report what is currently wired up, change nothing

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 status
  powershell -ExecutionPolicy Bypass -File .\install.ps1 install
#>
[CmdletBinding()]
param(
  [ValidateSet('install', 'uninstall', 'status')]
  [string]$Action = 'install',

  [string]$ProfileName = 'desktop'
)

$ErrorActionPreference = 'Stop'

$PluginDir = $PSScriptRoot
$PluginName = '@local/dsh-chat-find'
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$ProfileDir = Join-Path $DshHome "profiles\$ProfileName"
$ProfileJson = Join-Path $ProfileDir 'package.json'
$InstalledDir = Join-Path $ProfileDir 'node_modules\@local\dsh-chat-find'
$PnpmBin = Join-Path $DshHome 'dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'

# Read the profile manifest as an object. Kept as a helper so backup + write
# stay in one place and a malformed JSON fails before anything is mutated.
function Read-ProfileJson {
  if (-not (Test-Path $ProfileJson)) { throw "profile package.json not found: $ProfileJson" }
  return Get-Content $ProfileJson -Raw | ConvertFrom-Json
}

function Write-ProfileJson($json) {
  $json | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $ProfileJson -Encoding UTF8
}

function Get-BundleList($json) {
  if ($null -eq $json.dsh -or $null -eq $json.dsh.profile) { return @() }
  return @($json.dsh.profile.bundles | Where-Object { $null -ne $_ })
}

function Get-Status {
  $inBundles = $false
  if (Test-Path $ProfileJson) {
    try { $inBundles = (Get-BundleList (Read-ProfileJson)) -contains $PluginName } catch { }
  }
  $installed = Test-Path $InstalledDir
  [pscustomobject]@{
    ProfileDir    = $ProfileDir
    Dependency    = if ($installed) { 'PRESENT' } else { 'absent' }
    BundlesEntry  = if ($inBundles) { 'PRESENT' } else { 'absent' }
    PatchRow      = 'must stay ABSENT (bundles already applies the package patch)'
    PluginFiles   = if (Test-Path (Join-Path $PluginDir 'client.js')) { 'ok' } else { 'MISSING' }
    RestartNeeded = if ($inBundles -and $installed) { 'only on first install' } else { 'n/a' }
  }
}

function Backup([string]$Path) {
  $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
  $dest = "$Path.bak-$stamp"
  Copy-Item -LiteralPath $Path -Destination $dest -Force
  return $dest
}

Write-Host "dsh-chat-find :: $Action" -ForegroundColor Cyan
Write-Host "  plugin : $PluginDir"
Write-Host "  profile: $ProfileDir"
Write-Host ''

if (-not (Test-Path $ProfileDir)) { throw "profile directory not found: $ProfileDir" }
if (-not (Test-Path (Join-Path $PluginDir 'client.js'))) { throw "plugin files missing in $PluginDir" }

switch ($Action) {
  'status' {
    Get-Status | Format-List
    break
  }

  'install' {
    if (Test-Path $ProfileJson) { Write-Host "backup: $(Backup $ProfileJson)" }

    Write-Host 'step 1/2: linking the package into the profile (pnpm file: copy)...'
    if (-not (Test-Path $PnpmBin)) { throw "pnpm not found at $PnpmBin" }
    $uri = 'file:' + ($PluginDir -replace '\\', '/')
    & node $PnpmBin --dir $ProfileDir add $uri
    if ($LASTEXITCODE -ne 0) { throw "pnpm add failed with exit code $LASTEXITCODE" }

    Write-Host 'step 2/2: adding the dsh.profile.bundles entry...'
    $json = Read-ProfileJson
    $bundles = Get-BundleList $json
    if ($bundles -contains $PluginName) {
      Write-Host '  entry already present; skipping'
    }
    else {
      # Preserve the existing array shape while appending exactly one entry.
      $json.dsh.profile.bundles = @($bundles + $PluginName)
      Write-ProfileJson $json
      Write-Host '  added'
    }

    Write-Host ''
    Get-Status | Format-List
    Write-Host 'DONE. First install needs one DSH restart; later client.js edits hot-reload in ~2s.' -ForegroundColor Yellow
    break
  }

  'uninstall' {
    if (Test-Path $ProfileJson) {
      Write-Host "backup: $(Backup $ProfileJson)"
      $json = Read-ProfileJson
      $bundles = Get-BundleList $json
      if ($bundles -contains $PluginName) {
        $json.dsh.profile.bundles = @($bundles | Where-Object { $_ -ne $PluginName })
        Write-ProfileJson $json
        Write-Host '  bundles entry removed'
      }
      else {
        Write-Host '  bundles entry already absent'
      }
    }
    if (Test-Path $PnpmBin) {
      Write-Host 'removing the dependency...'
      & node $PnpmBin --dir $ProfileDir remove $PluginName
    }
    Write-Host ''
    Get-Status | Format-List
    Write-Host 'DONE. Restart DSH to unload the plugin.' -ForegroundColor Yellow
    break
  }
}
