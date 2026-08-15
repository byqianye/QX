$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$installer = Join-Path $root "qx-test-installer.exe"
$node = Join-Path $root "node.exe"
$canary = Join-Path $root "scripts\tauri-cdp-canary.mjs"
$artifacts = Join-Path $root "artifacts"
$evidence = Join-Path $artifacts "tauri-hls-20s-local-e2e.json"
$log = Join-Path $artifacts "tauri-hls-20s-local-e2e.log"
$stdout = Join-Path $artifacts "tauri-hls-20s-local-e2e.stdout.log"
$stderr = Join-Path $artifacts "tauri-hls-20s-local-e2e.stderr.log"
$work = Join-Path $env:TEMP ("qx-jianpian-e2e-" + [Guid]::NewGuid().ToString("N"))
$install = Join-Path $work "installed"
$exitCode = 1

try {
    foreach ($required in @($installer, $node, $canary)) {
        if (-not (Test-Path -LiteralPath $required)) {
            throw "REQUIRED_FILE_MISSING: $required"
        }
    }
    New-Item -ItemType Directory -Force -Path $artifacts, $install | Out-Null
    $installResult = Start-Process -FilePath $installer -ArgumentList @("/S", "/D=$install") -Wait -PassThru
    if ($installResult.ExitCode -ne 0) {
        throw "INSTALLER_EXIT_CODE: $($installResult.ExitCode)"
    }
    $executable = Get-ChildItem -LiteralPath $install -Filter "qx-yingshi.exe" -File -Recurse | Select-Object -First 1
    if ($null -eq $executable) {
        throw "TAURI_EXECUTABLE_MISSING"
    }

    $siteKey = [string]([char]0x8350) + [char]0x7247
    $searchKey = [string]([char]0x6D41) + [char]0x6D6A + [char]0x5730 + [char]0x7403
    $arguments = @(
        $canary,
        "--exe", $executable.FullName,
        "--installer", $installer,
        "--config-url", "http://xn--z7x900a.net/",
        "--site-key", $siteKey,
        "--search-key", $searchKey,
        "--playback",
        "--output", "artifacts\tauri-hls-20s-local-e2e.json"
    )
    $canaryProcess = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $root -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $exitCode = $canaryProcess.ExitCode
    $stdoutText = if (Test-Path -LiteralPath $stdout) { Get-Content -LiteralPath $stdout -Raw } else { "" }
    $stderrText = if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr -Raw } else { "" }
    Set-Content -LiteralPath $log -Value ($stdoutText + "`r`n" + $stderrText) -Encoding utf8
} catch {
    $exitCode = 1
    New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
    Add-Content -LiteralPath $log -Value ($_ | Out-String)
} finally {
    $uninstaller = Get-ChildItem -LiteralPath $install -Filter "uninstall.exe" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $uninstaller) {
        Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -Wait -WindowStyle Hidden | Out-Null
    }
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $evidence) {
    curl.exe --fail --silent --show-error -X POST --data-binary "@$evidence" "http://192.168.241.1:8766/upload/jianpian.json"
}
if (Test-Path -LiteralPath $log) {
    curl.exe --fail --silent --show-error -X POST --data-binary "@$log" "http://192.168.241.1:8766/upload/jianpian.log"
    Get-Content -LiteralPath $log -Raw
}
if ($exitCode -ne 0) {
    throw "JIANPIAN_HLS_E2E_FAILED: $exitCode"
}
Write-Host "JIANPIAN_HLS_E2E_PASSED"
