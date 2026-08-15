@echo off
set "ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\tauri-clean-win11-prepare-clean.ps1"
echo.
pause
