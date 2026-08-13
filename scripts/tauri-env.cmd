@echo off
setlocal

if exist "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" (
  call "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" -arch=x64 >nul
  if errorlevel 1 exit /b %errorlevel%
)

node "%~dp0..\node_modules\@tauri-apps\cli\tauri.js" %*
exit /b %errorlevel%
