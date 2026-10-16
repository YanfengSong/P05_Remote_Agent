@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\deployment\migrate-matlab-toolkit.ps1" %*
exit /b %ERRORLEVEL%
