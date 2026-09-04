@echo off
setlocal

set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"

echo ============================================================
echo   iLab CONJURE + ChatGPT Web Image Bridge (1-Click Launcher)
echo ============================================================
echo.

if exist "%PROJECT_DIR%bin\bun.exe" (
  set "BUN_CMD=%PROJECT_DIR%bin\bun.exe"
) else if exist "%PROJECT_DIR%chatgpt-bridge\bun.exe" (
  set "BUN_CMD=%PROJECT_DIR%chatgpt-bridge\bun.exe"
) else (
  where bun >nul 2>nul
  if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Khong tim thay Bun runtime tren may nay!
    echo [ERROR] Vui long cai dat Bun (https://bun.sh) hoac dat bun.exe vao thu muc bin\.
    pause
    exit /b 1
  )
  set "BUN_CMD=bun"
)

if not exist "%PROJECT_DIR%data" mkdir "%PROJECT_DIR%data"
set "CHATGPT_PROFILE_DIR=%PROJECT_DIR%data\chatgpt-profile"

"%BUN_CMD%" run "%PROJECT_DIR%chatgpt-bridge\src\check-session.ts" >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
  echo [!] Phat hien chua co phien dang nhap ChatGPT tren may nay.
  echo [!] Dang mo trinh duyet de ban dang nhap ChatGPT...
  echo [!] LUU Y: Sau khi dang nhap xong tren web, trinh duyet se tu dong dong lai de tiep tuc!
  echo.
  call "%BUN_CMD%" run "%PROJECT_DIR%chatgpt-bridge\src\cli.ts" --login
  echo.
)

powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/health' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 }; exit 1 } catch { exit 1 }" >nul 2>nul
if %ERRORLEVEL% EQU 0 goto :bridge_ready

echo [1/2] Dang khoi dong ChatGPT Image Bridge Server Port 3000...
start "ChatGPT Image Bridge" /d "%PROJECT_DIR%chatgpt-bridge" cmd /k ""%BUN_CMD%" run src/server.ts"

echo Dang doi Bridge Server san sang...
set /a ATTEMPTS=0
:wait_bridge
set /a ATTEMPTS+=1
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/health' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 }; exit 1 } catch { exit 1 }" >nul 2>nul
if %ERRORLEVEL% EQU 0 goto :bridge_ready
if %ATTEMPTS% GEQ 10 goto :bridge_timeout
ping 127.0.0.1 -n 2 >nul
goto :wait_bridge

:bridge_timeout
echo [CANH BAO] Khong the ket noi toi Bridge Server sau 10 giay. Tiep tuc khoi dong WebUI...
goto :start_webui

:bridge_ready
echo [1/2] ChatGPT Image Bridge Server da san sang tai http://127.0.0.1:3000.

:start_webui
echo [2/2] Dang khoi dong iLab CONJURE WebUI Port 8787...
if exist "%PROJECT_DIR%Start WebUI Portable.bat" (
  call "%PROJECT_DIR%Start WebUI Portable.bat"
) else (
  call "%PROJECT_DIR%Start WebUI.bat"
)
