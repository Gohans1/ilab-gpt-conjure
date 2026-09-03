@echo off
setlocal

set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"

echo ============================================================
echo   iLab CONJURE + ChatGPT Web Image Bridge Starter
echo ============================================================
echo.

powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/health' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 }; exit 1 } catch { exit 1 }" >nul 2>nul
if %ERRORLEVEL% EQU 0 goto :bridge_ready

echo [1/2] Dang khoi dong ChatGPT Image Bridge Server Port 3000...
start "ChatGPT Image Bridge" /d "%PROJECT_DIR%chatgpt-bridge" cmd /k "bun run src/server.ts"
ping 127.0.0.1 -n 3 >nul
goto :start_webui

:bridge_ready
echo [1/2] ChatGPT Image Bridge Server da chay san tai http://127.0.0.1:3000.

:start_webui
echo [2/2] Dang khoi dong iLab CONJURE WebUI Port 8787...
call "%PROJECT_DIR%Start WebUI.bat"
