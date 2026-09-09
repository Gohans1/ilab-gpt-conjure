@echo off
title ChatGPT Image CLI - Tao Anh
cd /d "%~dp0"
set /p prompt="Nhap prompt tao anh: "
if "%prompt%"=="" (
  echo Prompt khong duoc de trong!
  pause
  exit /b
)
echo ===================================================
echo   Dang tao anh voi prompt: "%prompt%"...
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
"%NODE_CMD%" dist\cli.js "%prompt%"
pause
