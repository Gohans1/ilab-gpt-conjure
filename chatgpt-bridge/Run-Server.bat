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

bun run src/server.ts
pause
