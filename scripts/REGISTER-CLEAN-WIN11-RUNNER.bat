@echo off
setlocal EnableExtensions
set "ROOT=%~dp0"

echo This must run in an elevated PowerShell/CMD on the clean Win11 VM.
echo Create a short-lived registration token in GitHub Actions ^> Runners first.
set /p "REG_TOKEN=Paste the one-time runner registration token: "
if not defined REG_TOKEN (
  echo REGISTRATION_TOKEN_MISSING
  pause
  exit /b 2
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%setup-qx-clean-win11-runner.ps1" -RegistrationToken "%REG_TOKEN%"
set "EXIT_CODE=%ERRORLEVEL%"
set "REG_TOKEN="
echo.
if "%EXIT_CODE%"=="0" (
  echo CLEAN_WIN11_RUNNER_REGISTERED
) else (
  echo CLEAN_WIN11_RUNNER_FAILED: %EXIT_CODE%
)
pause
exit /b %EXIT_CODE%
