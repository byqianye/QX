@echo off
setlocal

set "ROOT=%~dp0"
set "QX_TAURI_CLEAN_E2E=1"
set "QX_TAURI_NSIS=%ROOT%QX影视_0.9.0-rc.1_x64-setup-test.exe"
set "QX_TAURI_EVIDENCE_PATH=artifacts\tauri-clean-win11-local-e2e.json"

if not exist "%QX_TAURI_NSIS%" (
  echo TEST_INSTALLER_MISSING: %QX_TAURI_NSIS%
  pause
  exit /b 2
)
if not exist "%ROOT%node.exe" (
  echo NODE_RUNTIME_MISSING: %ROOT%node.exe
  pause
  exit /b 3
)
if not exist "%ROOT%scripts\tauri-clean-win11-e2e.mjs" (
  echo E2E_SCRIPT_MISSING: %ROOT%scripts\tauri-clean-win11-e2e.mjs
  pause
  exit /b 4
)

"%ROOT%node.exe" "%ROOT%scripts\tauri-clean-win11-e2e.mjs"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" (
  echo CLEAN_WIN11_E2E_PASSED
) else (
  echo CLEAN_WIN11_E2E_FAILED: %EXIT_CODE%
)
pause
exit /b %EXIT_CODE%
