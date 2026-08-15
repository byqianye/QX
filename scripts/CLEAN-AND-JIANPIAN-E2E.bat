@echo off
setlocal EnableExtensions
set "ROOT=%~dp0"

call "%ROOT%CLEAN-AND-RUN-E2E.bat"
set "CLEAN_CODE=%ERRORLEVEL%"
if not "%CLEAN_CODE%"=="0" (
  echo CLEAN_E2E_FAILED: %CLEAN_CODE%
  pause
  exit /b %CLEAN_CODE%
)

call "%ROOT%REAL-JIANPIAN-E2E.bat"
set "JIANPIAN_CODE=%ERRORLEVEL%"
echo FINAL_E2E_CODE=%JIANPIAN_CODE%
pause
exit /b %JIANPIAN_CODE%
