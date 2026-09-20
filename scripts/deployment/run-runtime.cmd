@echo off
REM P05 Remote Agent - long-lived tunnel runtime launcher.
REM Source-controlled operational entrypoint. Windows Task Scheduler remains the host authorization boundary.
setlocal

for %%I in ("%~dp0..\..") do set "P05_ROOT=%%~fI"
set "STATE_DIR=%P05_ROOT%\.p05"
set "LOG_DIR=%STATE_DIR%\logs"
set "LOG=%LOG_DIR%\runtime-launcher.log"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

REM Runtime key is read from HKCU Environment at launch time. It is never written by this script.
for /f "tokens=2,*" %%a in ('reg query "HKCU\Environment" /v CONTROL_PLANE_API_KEY') do set "CONTROL_PLANE_API_KEY=%%b"

set "CONTROL_PLANE_HTTP_PROXY=http://127.0.0.1:7892"
set "HTTPS_PROXY=http://127.0.0.1:7892"
set "HTTP_PROXY=http://127.0.0.1:7892"
set "P05_STATE_DIR=%STATE_DIR%"

echo ==== runtimes connect %DATE% %TIME% ==== >> "%LOG%"
"D:\Tools\tunnel-client\tunnel-client.exe" runtimes connect ^
  --alias p05-boonray ^
  --tunnel-id tunnel_6aaf525bd7b88191a7e7325dd56b218b ^
  --runtime-api-key env:CONTROL_PLANE_API_KEY ^
  --mcp-command "D:/Tools/node-v22.23.1-win-x64/node.exe --env-file-if-exists=D:/Project_Git/P05_Remote_Agent/.env D:/Project_Git/P05_Remote_Agent/dist/index.js" ^
  --profile p05-boonray5cd6065z9h >> "%LOG%" 2>&1

echo ==== connect exited %ERRORLEVEL% %DATE% %TIME% ==== >> "%LOG%"
