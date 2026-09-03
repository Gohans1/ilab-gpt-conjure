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
bun run src/cli.ts "%prompt%"
pause
