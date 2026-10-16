@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\sync\publish-golden-state.ps1"
set "code=%errorlevel%"
echo.
if not "%code%"=="0" pause
exit /b %code%
