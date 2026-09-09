@echo off
title ChatGPT Image CLI - Dang Nhap
cd /d "%~dp0"
echo ===================================================
echo   Dang mo trinh duyet Chrome de dang nhap ChatGPT...
echo   Vui long dang nhap tren cua so Chrome vua mo.
echo ===================================================
set "BUN_CMD=bun"
if exist "%~dp0..\bin\bun.exe" set "BUN_CMD=%~dp0..\bin\bun.exe"
set "NODE_CMD=node"
if exist "%~dp0..\bin\node.exe" set "NODE_CMD=%~dp0..\bin\node.exe"
if exist "node_modules\typescript\bin\tsc" (
  call "%BUN_CMD%" run build
  if errorlevel 1 exit /b 1
) else if not exist "dist\cli.js" (
  echo Thieu ban ChatGPT Bridge da bien dich!
  exit /b 1
)
"%NODE_CMD%" dist\cli.js --login
pause
