@echo off
set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tauri-jianpian-hls-shared-e2e.ps1"
echo.
pause
