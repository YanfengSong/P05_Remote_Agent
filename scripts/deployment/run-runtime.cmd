@echo off
REM Compatibility launcher. Canonical implementation is run-runtime.ps1.
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0run-runtime.ps1"
exit /b %ERRORLEVEL%
