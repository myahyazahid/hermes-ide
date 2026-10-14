<#
  End-to-end check of the Windows installer on this machine: fresh install, launch, in-place update while the IDE is
  running (the same command line the extension uses), then uninstall and a check that nothing is left behind.

    pwsh/powershell -File ide\scripts\e2e-install.ps1 -Old <older HermesIDE-Setup-x64-*.exe> -New <newer one>

  Both installers must be builds of this repo with different versions, e.g.
    npm run ide:build                                   # 0.4.0 -> copy ide\out\x64\HermesIDE-Setup-x64-0.4.0.exe aside
    node ide/scripts/build.mjs --version 0.4.1 --skip-package   # the "new" one

  It installs into a short folder under %TEMP%, and writes (then removes) the per-user registry entries a real install
  writes: the Uninstall key, the Explorer context menus, and PATH. Nothing needs administrator rights.

  Every Setup call is forced to per-user mode (/CURRENTUSER). Without that, Setup inherits the mode of an existing install
  with the same id, so on a machine that already has Hermes IDE installed for all users it would re-elevate and overwrite
  that install's registration. With it, a system-wide install is left alone (the script says so); a per-user install is
  refused, because the test would replace it.

  Optional: check the installer's "Install Hermes Agent" task without installing Hermes. Build BOTH installers with a
  stand-in command that leaves a marker file (this also makes the installer believe Hermes is missing):

    node ide/scripts/build.mjs --hermes-install-command "New-Item -ItemType Directory -Force $env:TEMP\hermes-ide-e2e | Out-Null; Set-Content $env:TEMP\hermes-ide-e2e\hermes-install-marker.txt ran"
    powershell -File ide\scripts\e2e-install.ps1 -Old <that installer> -New <newer> -HermesMarker

  It then checks that a silent install does NOT run the task by default, that /INSTALLHERMES=1 does, and that an
  update (/UPDATE=1) never does, even when /INSTALLHERMES=1 is passed.
#>
param(
  [Parameter(Mandatory)] [string] $Old,
  [Parameter(Mandatory)] [string] $New,
  [string] $Dir = (Join-Path $env:TEMP 'hermes-ide-e2e\app'),
  [switch] $SkipSmoke,
  [switch] $HermesMarker
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$brand = Get-Content (Join-Path $root 'ide\brand.json') -Raw | ConvertFrom-Json
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + ($brand.appIds.x64 -replace '^\{\{', '{') + '_is1'
$exe = Join-Path $Dir "$($brand.name).exe"
$work = Join-Path $env:TEMP 'hermes-ide-e2e'
$profileDir = Join-Path $env:APPDATA $brand.name
$profileExisted = Test-Path $profileDir

# The IDE must start as an Electron app: drop what the VS Code extension host (or a VS Code terminal) sets.
Remove-Item Env:ELECTRON_RUN_AS_NODE, Env:ELECTRON_NO_ATTACH_CONSOLE -ErrorAction SilentlyContinue
Get-ChildItem Env: | Where-Object { $_.Name -like 'VSCODE_*' } | ForEach-Object { Remove-Item "Env:$($_.Name)" }

$failures = New-Object System.Collections.Generic.List[string]
function Check([string] $what, [bool] $ok, [string] $detail = '') {
  if ($ok) { Write-Host "  PASS  $what" -ForegroundColor Green }
  else { Write-Host "  FAIL  $what $detail" -ForegroundColor Red; $failures.Add($what) }
}
function RawPath { (Get-Item 'HKCU:\Environment').GetValue('Path', $null, 'DoNotExpandEnvironmentNames') }
function FileVersion { (Get-Item $exe).VersionInfo.FileVersion }
function IdeProcesses { Get-Process -Name $brand.name -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } }
function StopIde { IdeProcesses | Stop-Process -Force -ErrorAction SilentlyContinue }
function Setup([string] $installer, [string[]] $extra) {
  # /CURRENTUSER: never inherit the mode of an existing all-users install (see the header).
  $argList = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER') + $extra
  Start-Process -FilePath $installer -ArgumentList $argList -Wait -PassThru
}

if (Test-Path $uninstallKey) { throw "$($brand.name) is already installed for this user. Uninstall it first; this test would overwrite it." }
$machineKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\' + ($brand.appIds.x64 -replace '^\{\{', '{') + '_is1'
if (Test-Path $machineKey) { Write-Host "note: $($brand.name) is installed for all users; this test stays in per-user mode and does not touch it." -ForegroundColor Yellow }
New-Item -ItemType Directory -Force $work | Out-Null
$pathBefore = RawPath
$marker = Join-Path $work 'hermes-install-marker.txt'
Remove-Item $marker -ErrorAction SilentlyContinue

try {
  Write-Host "`n[1] Fresh install of $(Split-Path $Old -Leaf)"
  $p = Setup $Old @('/SP-', "/DIR=`"$Dir`"", "/LOG=`"$work\install.log`"")
  Check 'installer exit code 0' ($p.ExitCode -eq 0) "(exit $($p.ExitCode); see $work\install.log)"
  Check 'exe installed' (Test-Path $exe)
  Check 'uninstaller installed' (Test-Path (Join-Path $Dir 'unins000.exe'))
  Check 'registered in Apps & features' (Test-Path $uninstallKey)
  Check 'bin folder added to PATH' ((RawPath) -like "*$Dir\bin*")
  Check 'Explorer context menus added' ((Test-Path 'HKCU:\Software\Classes\*\shell\HermesIDE') -and (Test-Path 'HKCU:\Software\Classes\Directory\shell\HermesIDE') -and (Test-Path 'HKCU:\Software\Classes\Directory\Background\shell\HermesIDE'))
  $oldVersion = FileVersion
  Write-Host "  installed version $oldVersion"
  if ($HermesMarker) {
    Check 'a silent install does not run the Hermes installer by default' (-not (Test-Path $marker))
    # Opt in explicitly on a second pass over the same folder (same version, so it only runs the task).
    $q = Setup $Old @('/SP-', '/INSTALLHERMES=1', "/DIR=`"$Dir`"", "/LOG=`"$work\install-hermes.log`"")
    Check 'installer exit code 0 with /INSTALLHERMES=1' ($q.ExitCode -eq 0) "(exit $($q.ExitCode); see $work\install-hermes.log)"
    Check '/INSTALLHERMES=1 runs the Hermes installer step' (Test-Path $marker)
    Remove-Item $marker -ErrorAction SilentlyContinue
  }

  if (-not $SkipSmoke) {
    Write-Host "`n[2] Smoke test of the installed copy (opens a window briefly)"
    & node (Join-Path $root 'ide\scripts\smoke.mjs') --dir $Dir
    Check 'bundled extension activates' ($LASTEXITCODE -eq 0)
  }

  Write-Host "`n[3] In-place update while the IDE is running"
  $ud = Join-Path $work 'ud'; $ed = Join-Path $work 'ext'
  $ide = Start-Process -FilePath $exe -ArgumentList @('--user-data-dir', "`"$ud`"", '--extensions-dir', "`"$ed`"", '--new-window') -PassThru
  Start-Sleep -Seconds 10
  Check 'old IDE is running' (-not $ide.HasExited)
  # Same arguments as INSTALLER_ARGS in src/core/updater.ts, and no /DIR: Setup has to find the existing folder itself.
  $updateArgs = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', '/UPDATE=1', "/LOG=`"$work\update.log`"")
  if ($HermesMarker) { $updateArgs += '/INSTALLHERMES=1' } # even when asked, an update must not reinstall Hermes
  $updateArgs += '/CURRENTUSER'
  $inst = Start-Process -FilePath $New -ArgumentList $updateArgs -PassThru
  Start-Sleep -Seconds 4
  Check 'installer waits while the IDE is open' (-not $inst.HasExited)
  $null = $ide.CloseMainWindow() # stands in for workbench.action.quit
  if (-not $inst.WaitForExit(300000)) { $inst.Kill() }
  Check 'installer exit code 0' ($inst.ExitCode -eq 0) "(exit $($inst.ExitCode); see $work\update.log)"
  Start-Sleep -Seconds 12
  $newVersion = FileVersion
  Check "version changed ($oldVersion -> $newVersion)" ($newVersion -ne $oldVersion)
  Check 'registry shows the new version' ((Get-ItemProperty $uninstallKey).DisplayVersion -eq ($newVersion -replace '\.0$', ''))
  Check 'IDE was relaunched by Setup' (@(IdeProcesses).Count -gt 0)
  if ($HermesMarker) { Check 'an update never runs the Hermes installer step' (-not (Test-Path $marker)) }
  StopIde
}
finally {
  Write-Host "`n[4] Uninstall and cleanup"
  StopIde
  $uninstaller = Join-Path $Dir 'unins000.exe'
  if (Test-Path $uninstaller) {
    $u = Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -Wait -PassThru
    Check 'uninstaller exit code 0' ($u.ExitCode -eq 0)
    Start-Sleep -Seconds 3
  }
  Check 'PATH is exactly as before' ((RawPath) -ceq $pathBefore)
  Check 'Apps & features entry removed' (-not (Test-Path $uninstallKey))
  Check 'context menus removed' (-not ((Test-Path 'HKCU:\Software\Classes\*\shell\HermesIDE') -or (Test-Path 'HKCU:\Software\Classes\Directory\shell\HermesIDE') -or (Test-Path 'HKCU:\Software\Classes\Directory\Background\shell\HermesIDE')))
  Check 'install folder removed' (-not (Test-Path $Dir))
  # The relaunch after the update has no --user-data-dir, so it creates the default profile; remove it only if we made it.
  if (-not $profileExisted -and (Test-Path $profileDir)) { Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($failures.Count) {
  Write-Host "`n$($failures.Count) check(s) failed. Logs are kept in $work" -ForegroundColor Red
  exit 1
}
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "`nAll checks passed." -ForegroundColor Green
