@echo off
setlocal

set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"

echo ============================================================
echo   iLab CONJURE + ChatGPT Web Image Bridge Starter
echo ============================================================
echo.

:: 1. Kiem tra xem Bridge Server port 3000 da chay chua
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/health' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 }; exit 1 } catch { exit 1 }" >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  echo [1/2] ChatGPT Image Bridge Server da chay san tai http://127.0.0.1:3000.
) else (
  echo [1/2] Dang khoi dong ChatGPT Image Bridge Server (Port 3000)...
  start "ChatGPT Image Bridge" cmd /k "cd /d ""%PROJECT_DIR%chatgpt-bridge"" && title ChatGPT Image Bridge (Port 3000) && bun run src/server.ts"
  :: Cho 2 giay de server khoi dong
  timeout /t 2 /nobreak >nul
)

:: 2. Khoi dong WebUI iLab CONJURE
echo [2/2] Dang khoi dong iLab CONJURE WebUI (Port 8787)...
call "%PROJECT_DIR%Start WebUI.bat"

exit /b %ERRORLEVEL%
