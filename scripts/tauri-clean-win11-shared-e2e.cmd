@echo off
setlocal EnableExtensions

set "ROOT=%~dp0"
set "QX_TAURI_CLEAN_E2E=1"
set "QX_TAURI_NSIS=%ROOT%qx-test-installer.exe"
set "QX_TAURI_EVIDENCE_PATH=artifacts\tauri-clean-win11-local-e2e.json"
set "E2E_LOG=%ROOT%artifacts\tauri-clean-win11-local-e2e.log"

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
if not exist "%ROOT%artifacts\" mkdir "%ROOT%artifacts"
if not exist "%ROOT%artifacts\" (
  echo E2E_ARTIFACTS_DIRECTORY_MISSING: %ROOT%artifacts
  pause
  exit /b 5
)

echo STARTING_CLEAN_WIN11_E2E
"%ROOT%node.exe" "%ROOT%scripts\tauri-clean-win11-e2e.mjs" > "%E2E_LOG%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"

if exist "%ROOT%artifacts\tauri-clean-win11-local-e2e.json" curl.exe --fail --silent --show-error -X POST --data-binary "@%ROOT%artifacts\tauri-clean-win11-local-e2e.json" "http://192.168.241.1:8766/upload/evidence.json"
if exist "%E2E_LOG%" curl.exe --fail --silent --show-error -X POST --data-binary "@%E2E_LOG%" "http://192.168.241.1:8766/upload/log.txt"

echo.
if "%EXIT_CODE%"=="0" (
  echo CLEAN_WIN11_E2E_PASSED
) else (
  echo CLEAN_WIN11_E2E_FAILED: %EXIT_CODE%
)
if exist "%E2E_LOG%" type "%E2E_LOG%"
pause
exit /b %EXIT_CODE%
