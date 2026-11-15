@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22+ is required: https://nodejs.org/
  pause
  exit /b 1
)

node web-agent.mjs %*
set "code=%errorlevel%"
echo.
if not "%code%"=="0" (
  echo Web Agent exited with code %code%.
  echo Log: %USERPROFILE%\.web-agent\app.log
  pause
  exit /b %code%
)
echo Web Agent stopped. Log: %USERPROFILE%\.web-agent\app.log
timeout /t 4 >nul
endlocal
