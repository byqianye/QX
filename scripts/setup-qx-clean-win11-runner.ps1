param(
  [Parameter(Mandatory = $true)]
  [string]$RegistrationToken,
  [string]$RunnerName = "QX-Win11-Clean",
  [string]$RunnerRoot = "C:\qx-win11-runner"
)

$ErrorActionPreference = "Stop"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script from an elevated PowerShell window so the runner service can be installed"
}

$os = Get-CimInstance Win32_OperatingSystem
if ($os.Caption -notmatch "Windows 11" -or $os.OSArchitecture -notmatch "64") {
  throw "This runner must be Windows 11 x64. Detected: $($os.Caption) / $($os.OSArchitecture)"
}

$legacyPaths = @(
  (Join-Path $env:LOCALAPPDATA "com.qx.yingshi.desktop"),
  (Join-Path $env:LOCALAPPDATA "QXMovie"),
  (Join-Path $env:LOCALAPPDATA "Programs\qx-yingshi")
) | Where-Object { Test-Path -LiteralPath $_ }
if ($legacyPaths.Count -gt 0) {
  throw "Uninstall the old QX application first; user data is preserved and is not deleted: $($legacyPaths -join ', ')"
}

if ($null -eq (Get-Command 7z.exe -ErrorAction SilentlyContinue)) {
  throw "7z.exe is required by the release workflow; install 7-Zip before registering this runner"
}

$release = Invoke-RestMethod -Uri "https://api.github.com/repos/actions/runner/releases/latest" -Headers @{ Accept = "application/vnd.github+json" }
$asset = $release.assets | Where-Object { $_.name -match '^actions-runner-win-x64-.*\.zip$' } | Select-Object -First 1
if ($null -eq $asset) { throw "The latest Windows x64 GitHub Actions runner archive was not found" }

New-Item -ItemType Directory -Force -Path $RunnerRoot | Out-Null
$archive = Join-Path $RunnerRoot $asset.name
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive
Expand-Archive -LiteralPath $archive -DestinationPath $RunnerRoot -Force
Remove-Item -LiteralPath $archive -Force

$config = Join-Path $RunnerRoot "config.cmd"
$service = Join-Path $RunnerRoot "svc.cmd"
if (-not (Test-Path -LiteralPath $config)) { throw "Runner config.cmd was not extracted" }

Push-Location $RunnerRoot
try {
  & $config --unattended --replace --url "https://github.com/byqianye/QX" --token $RegistrationToken --name $RunnerName --labels "qx-clean-win11" --work "_work"
  if ($LASTEXITCODE -ne 0) { throw "GitHub Actions runner registration failed with code $LASTEXITCODE" }
  & $service install
  if ($LASTEXITCODE -ne 0) { throw "GitHub Actions runner service installation failed with code $LASTEXITCODE" }
  & $service start
  if ($LASTEXITCODE -ne 0) { throw "GitHub Actions runner service start failed with code $LASTEXITCODE" }
} finally {
  Pop-Location
}

Write-Output "Registered $RunnerName with label qx-clean-win11. Keep this VM powered on for the signed release workflow."
