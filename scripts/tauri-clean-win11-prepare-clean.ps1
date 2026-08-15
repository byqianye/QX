$ErrorActionPreference = "Stop"

$targets = @(
    @{ Name = "app-data"; Path = Join-Path $env:LOCALAPPDATA "com.qx.yingshi.desktop" },
    @{ Name = "movie-data"; Path = Join-Path $env:LOCALAPPDATA "QXMovie" },
    @{ Name = "installed-app"; Path = Join-Path $env:LOCALAPPDATA "Programs\qx-yingshi" }
)

$existing = @($targets | Where-Object { Test-Path -LiteralPath $_.Path })
if ($existing.Count -eq 0) {
    Write-Host "NO_QX_PATHS_FOUND"
    exit 0
}

$qxProcesses = @(Get-Process -Name "qx-yingshi" -ErrorAction SilentlyContinue)
if ($qxProcesses.Count -gt 0) {
    throw "QX_PROCESS_RUNNING: close QX Yingshi before preparing the clean host"
}

$registry = @(reg.exe query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall" /s /f "com.qx.yingshi.desktop" 2>$null)
if ($registry -match "com\.qx\.yingshi\.desktop") {
    throw "QX_UNINSTALL_ENTRY_PRESENT: uninstall QX from Windows Settings first"
}

Write-Host "The following exact paths will be moved to a desktop backup:"
$existing | ForEach-Object { Write-Host $_.Path }
$answer = Read-Host "Type YES to continue"
if ($answer -cne "YES") {
    Write-Host "CLEANUP_CANCELLED"
    exit 2
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = Join-Path ([Environment]::GetFolderPath("Desktop")) "QX-E2E-backup-$stamp"
New-Item -ItemType Directory -Force -Path $backup | Out-Null

foreach ($target in $existing) {
    $destination = Join-Path $backup $target.Name
    Move-Item -LiteralPath $target.Path -Destination $destination
    Write-Host "MOVED $($target.Path) -> $destination"
}

$remaining = @($targets | Where-Object { Test-Path -LiteralPath $_.Path })
if ($remaining.Count -gt 0) {
    throw "QX_PATHS_REMAIN: $($remaining.Path -join '; ')"
}

Write-Host "CLEAN_WIN11_HOST_READY"
Write-Host "BACKUP=$backup"
