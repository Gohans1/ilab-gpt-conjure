@echo off
title ChatGPT Image Local Bridge Server (for iLab CONJURE)
cd /d "%~dp0"

echo ===================================================
echo 🚀 KHOI CHAY CHATGPT IMAGE LOCAL BRIDGE SERVER
echo ===================================================
echo 👉 Server se chay tai: http://127.0.0.1:3000
echo 👉 Trong iLab CONJURE, them Custom Provider:
echo    - Base URL: http://127.0.0.1:3000/v1
echo    - API Key: sk-local
echo    - Model: gpt-image-2
echo    - Protocol: Images API (/images/generations)
echo ===================================================
echo.

set "BUN_CMD=bun"
if exist "%~dp0..\bin\bun.exe" set "BUN_CMD=%~dp0..\bin\bun.exe"
set "NODE_CMD=node"
if exist "%~dp0..\bin\node.exe" set "NODE_CMD=%~dp0..\bin\node.exe"
if exist "node_modules\typescript\bin\tsc" (
  call "%BUN_CMD%" run build
  if errorlevel 1 exit /b 1
) else if not exist "dist\node-server.js" (
  echo Thieu ban ChatGPT Bridge da bien dich!
  exit /b 1
)
"%NODE_CMD%" dist\node-server.js
pause
