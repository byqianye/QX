@echo off
setlocal EnableExtensions
set "ROOT=%~dp0"

echo PREPARING_CLEAN_WIN11_HOST
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\tauri-clean-win11-prepare-clean.ps1"
set "CLEAN_CODE=%ERRORLEVEL%"
if not "%CLEAN_CODE%"=="0" (
  echo CLEANUP_FAILED: %CLEAN_CODE%
  pause
  exit /b %CLEAN_CODE%
)

echo STARTING_CLEAN_WIN11_E2E
call "%ROOT%run-clean-win11-e2e.cmd"
set "E2E_CODE=%ERRORLEVEL%"
echo FINAL_E2E_CODE=%E2E_CODE%
pause
exit /b %E2E_CODE%
