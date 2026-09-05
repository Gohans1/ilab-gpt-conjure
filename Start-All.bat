@echo off
setlocal

title iLab CONJURE Controller
set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"

:: 0. Chống đơ console (Disable QuickEdit Mode an toàn qua Win32 API, không đụng Registry)
if exist "%PROJECT_DIR%scripts\disable-quickedit.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_DIR%scripts\disable-quickedit.ps1" >nul 2>nul
)

echo ============================================================
echo   iLab CONJURE + ChatGPT Web Image Bridge (Controller)
echo ============================================================
echo.

:: 1. Ensure essential directories exist
if not exist "%PROJECT_DIR%output" mkdir "%PROJECT_DIR%output"
if not exist "%PROJECT_DIR%data" mkdir "%PROJECT_DIR%data"
if not exist "%PROJECT_DIR%bin" mkdir "%PROJECT_DIR%bin"
set "BRIDGE_LOG=%PROJECT_DIR%output\bridge-server.log"
set "WEBUI_LOG=%PROJECT_DIR%output\webui-server.log"
set "CHATGPT_PROFILE_DIR=%PROJECT_DIR%data\chatgpt-profile"

:: 2. Check Bun runtime (Auto-download if missing)
set "BUN_CMD="
if exist "%PROJECT_DIR%bin\bun.exe" (
  set "BUN_CMD=%PROJECT_DIR%bin\bun.exe"
) else if exist "%PROJECT_DIR%chatgpt-bridge\bun.exe" (
  set "BUN_CMD=%PROJECT_DIR%chatgpt-bridge\bun.exe"
) else (
  where bun >nul 2>nul
  if %ERRORLEVEL% EQU 0 set "BUN_CMD=bun"
)

if not defined BUN_CMD (
  echo [INFO] Chua co Bun runtime. Dang tu dong tai Bun ve bin\bun.exe...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64.zip' -OutFile '%PROJECT_DIR%bin\bun.zip'; Expand-Archive -Path '%PROJECT_DIR%bin\bun.zip' -DestinationPath '%PROJECT_DIR%bin' -Force; Move-Item -Path '%PROJECT_DIR%bin\bun-windows-x64\bun.exe' -Destination '%PROJECT_DIR%bin\bun.exe' -Force; Remove-Item -Path '%PROJECT_DIR%bin\bun.zip', '%PROJECT_DIR%bin\bun-windows-x64' -Recurse -Force" >nul 2>nul
  if exist "%PROJECT_DIR%bin\bun.exe" (
    set "BUN_CMD=%PROJECT_DIR%bin\bun.exe"
    echo [INFO] Da tai Bun thanh cong.
  ) else (
    echo [ERROR] Tu dong tai Bun that bai! Vui long cai tai https://bun.sh hoac dat bun.exe vao bin\.
    pause
    exit /b 1
  )
)

:: 3. Check / Install Bridge dependencies
if not exist "%PROJECT_DIR%chatgpt-bridge\node_modules" (
  echo [INFO] Dang cai dat dependencies cho ChatGPT Bridge...
  pushd "%PROJECT_DIR%chatgpt-bridge"
  call "%BUN_CMD%" install
  popd
)
echo [1/4] Bun runtime va Bridge modules: SAN SANG.

:: 4. Isolate UV cache and Python installs to project directory (.uv)
set "UV_CACHE_DIR=%PROJECT_DIR%.uv\cache"
set "UV_PYTHON_INSTALL_DIR=%PROJECT_DIR%.uv\python"
set "UV_LINK_MODE=copy"
set "UV_NO_CONFIG=1"

set "VENV_DIR=%PROJECT_DIR%.venv"
set "PYTHON_BIN=%VENV_DIR%\Scripts\python.exe"

:: Luon luon do tim uv truoc (tranh loi logic khi .venv da co san)
set "UV_CMD="
if exist "%PROJECT_DIR%bin\uv.exe" (
  set "UV_CMD=%PROJECT_DIR%bin\uv.exe"
) else (
  where uv >nul 2>nul
  if %ERRORLEVEL% EQU 0 set "UV_CMD=uv"
)

if exist "%PYTHON_BIN%" goto :python_ready

if not defined UV_CMD (
  echo [INFO] Dang tu dong tai uv package manager ve bin\uv.exe...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' -OutFile '%PROJECT_DIR%bin\uv.zip'; Expand-Archive -Path '%PROJECT_DIR%bin\uv.zip' -DestinationPath '%PROJECT_DIR%bin' -Force; Remove-Item -Path '%PROJECT_DIR%bin\uv.zip' -Force" >nul 2>nul
  if exist "%PROJECT_DIR%bin\uv.exe" (
    set "UV_CMD=%PROJECT_DIR%bin\uv.exe"
    echo [INFO] Da tai uv thanh cong.
  )
)

if defined UV_CMD (
  echo [INFO] Dang tao moi truong Python 3.11 thuan khiet bang uv...
  "%UV_CMD%" venv "%VENV_DIR%" --python 3.11
  if exist "%PYTHON_BIN%" (
    echo [INFO] Dang cai dat WebUI dependencies bang uv...
    "%UV_CMD%" pip install -p "%PYTHON_BIN%" --require-hashes -r "%PROJECT_DIR%requirements-webui.txt"
    goto :python_ready
  )
)

:: Fallback if uv failed: Try system python
set "SYSTEM_PYTHON="
py -3 --version >nul 2>nul
if not errorlevel 1 (
  set "SYSTEM_PYTHON=py -3"
) else (
  where python >nul 2>nul
  if not errorlevel 1 set "SYSTEM_PYTHON=python"
)

if not defined SYSTEM_PYTHON (
  echo [ERROR] Khong the tu dong khoi tao Python! Vui long cai dat Python 3.10+.
  pause
  exit /b 1
)

echo [INFO] Dang tao virtual environment tu Python he thong...
%SYSTEM_PYTHON% -m venv "%VENV_DIR%"
if not exist "%PYTHON_BIN%" (
  echo [ERROR] Tao virtual environment that bai!
  pause
  exit /b 1
)

:python_ready

:: Verify runtime dependencies
"%PYTHON_BIN%" -m codex_image.dependency_check --requirements "%PROJECT_DIR%requirements-webui.txt" >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
  echo [INFO] Dang cai dat / cap nhat WebUI dependencies...
  if defined UV_CMD (
    "%UV_CMD%" pip install -p "%PYTHON_BIN%" --require-hashes -r "%PROJECT_DIR%requirements-webui.txt"
  ) else (
    "%PYTHON_BIN%" -m pip install --require-hashes -r "%PROJECT_DIR%requirements-webui.txt"
  )
  if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Cai dat WebUI dependencies that bai!
    pause
    exit /b 1
  )
)

:: Double-check QuickEdit disable via python ctypes
"%PYTHON_BIN%" -c "import ctypes; h=ctypes.windll.kernel32.GetStdHandle(-10); m=ctypes.c_uint(); ctypes.windll.kernel32.GetConsoleMode(h, ctypes.byref(m)); ctypes.windll.kernel32.SetConsoleMode(h, m.value & ~0x0040)" >nul 2>nul

echo [2/4] Python environment va WebUI dependencies: SAN SANG.

:: 5. Init Auth Settings
set "AUTH_SETTINGS_PATH=%PROJECT_DIR%output\webui-auth-settings.json"
"%PYTHON_BIN%" -m codex_image.webui.startup_auth --settings-path "%AUTH_SETTINGS_PATH%" >nul 2>nul

:: 6. Check ChatGPT session
"%BUN_CMD%" run "%PROJECT_DIR%chatgpt-bridge\src\check-session.ts" >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  echo [3/4] ChatGPT Session: DA DANG NHAP.
) else (
  echo [3/4] ChatGPT Session: CHUA DANG NHAP [co the dang nhap tren WebUI sau].
)

:: 7. Start ChatGPT Bridge (Port 3000)
powershell -NoProfile -Command "$conns = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue; if ($conns) { try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/health' -TimeoutSec 1; if ($r.StatusCode -ne 200) { $conns | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -match 'bun|node') { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } } } } catch { $conns | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -match 'bun|node') { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } } } }" >nul 2>nul
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/health' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 }; exit 1 } catch { exit 1 }" >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  echo [4/4] Bridge Server da chay san tai http://127.0.0.1:3000.
  goto :start_webui
)

echo [4/4] Dang khoi dong ChatGPT Image Bridge (Port 3000)...
start "" /b cmd /c "cd /d "%PROJECT_DIR%chatgpt-bridge" && "%BUN_CMD%" run src/server.ts > "%BRIDGE_LOG%" 2>&1"

set /a ATTEMPTS=0
:wait_bridge
set /a ATTEMPTS+=1
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/health' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 }; exit 1 } catch { exit 1 }" >nul 2>nul
if %ERRORLEVEL% EQU 0 goto :bridge_ready
if %ATTEMPTS% GEQ 15 goto :bridge_timeout
ping 127.0.0.1 -n 2 >nul
goto :wait_bridge

:bridge_timeout
echo [CANH BAO] Bridge Server khong phan hoi sau 15 giay. Kiem tra: %BRIDGE_LOG%
goto :start_webui

:bridge_ready
echo       ChatGPT Image Bridge da san sang tai http://127.0.0.1:3000.

:start_webui
powershell -NoProfile -Command "$conns = Get-NetTCPConnection -LocalPort 8787 -ErrorAction SilentlyContinue; if ($conns) { try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 1; if ($r.StatusCode -ne 200) { $conns | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -match 'python') { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } } } } catch { $conns | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -match 'python') { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } } } }" >nul 2>nul
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 }; exit 1 } catch { exit 1 }" >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  echo       iLab CONJURE WebUI da chay san tai http://127.0.0.1:8787.
  goto :launch_browser
)

echo Dang khoi dong iLab CONJURE WebUI (Port 8787)...
start "" /b cmd /c ""%PYTHON_BIN%" -m codex_image.webui.server codex_image.webui.app:app --host 127.0.0.1 --port 8787 --no-access-log --timeout-graceful-shutdown 5 > "%WEBUI_LOG%" 2>&1"

set /a ATTEMPTS=0
:wait_webui
set /a ATTEMPTS+=1
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 }; exit 1 } catch { exit 1 }" >nul 2>nul
if %ERRORLEVEL% EQU 0 goto :webui_ready
if %ATTEMPTS% GEQ 20 goto :webui_timeout
ping 127.0.0.1 -n 2 >nul
goto :wait_webui

:webui_timeout
echo [CANH BAO] WebUI Server khong phan hoi sau 20 giay. Kiem tra: %WEBUI_LOG%
goto :dashboard

:webui_ready
echo       iLab CONJURE WebUI da san sang tai http://127.0.0.1:8787.

:launch_browser
start "" "http://127.0.0.1:8787/"

:dashboard
cls
echo ============================================================
echo   iLab CONJURE Controller - Dashboard Dang Hoat Dong
echo ============================================================
echo.
echo   [*] ChatGPT Bridge : http://127.0.0.1:3000   [RUNNING]
echo   [*] iLab WebUI     : http://127.0.0.1:8787   [RUNNING]
echo.
echo   Trinh duyet da mo  : http://127.0.0.1:8787/
echo   Bridge Server Log  : output\bridge-server.log
echo   WebUI Server Log   : output\webui-server.log
echo.
echo ------------------------------------------------------------
echo   NHAN BAT KY PHIM NAO DE DUNG TAT CA DICH VU VA THOAT
echo ------------------------------------------------------------
echo.
pause >nul

:shutdown
echo.
echo Dang tat tat ca server va tien trinh lien quan...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000, 8787 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { $p = Get-Process -Id $_ -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -match 'bun|node|python|cmd') { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } }" >nul 2>nul
powershell -NoProfile -Command "Get-Process bun, python -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*ilab-conjure*' } | Stop-Process -Force -ErrorAction SilentlyContinue" >nul 2>nul
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*chatgpt-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>nul
echo Da tat toan bo tien trinh an toan. Tam biet!
ping 127.0.0.1 -n 3 >nul
exit /b 0
