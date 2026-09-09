@echo off
setlocal

title iLab CONJURE - Dang nhap ChatGPT
set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"

:: 0. Chong do console (Disable QuickEdit Mode tuc thi < 3ms qua Win32 API)
if not exist "%PROJECT_DIR%bin" mkdir "%PROJECT_DIR%bin"
if not exist "%PROJECT_DIR%bin\disable-quickedit.exe" (
  if exist "%PROJECT_DIR%scripts\disable-quickedit.cs" (
    if exist "%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" (
      "%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /optimize /target:winexe /out:"%PROJECT_DIR%bin\disable-quickedit.exe" "%PROJECT_DIR%scripts\disable-quickedit.cs" >nul 2>nul
    ) else if exist "%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe" (
      "%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe" /nologo /optimize /target:winexe /out:"%PROJECT_DIR%bin\disable-quickedit.exe" "%PROJECT_DIR%scripts\disable-quickedit.cs" >nul 2>nul
    )
  )
)
if exist "%PROJECT_DIR%bin\disable-quickedit.exe" (
  "%PROJECT_DIR%bin\disable-quickedit.exe"
)

echo ============================================================
echo   iLab CONJURE - Dang nhap ChatGPT Web
echo ===========================================================
echo.

:: 1. Check Bun runtime
set "BUN_CMD="
if exist "%PROJECT_DIR%bin\bun.exe" (
  set "BUN_CMD=%PROJECT_DIR%bin\bun.exe"
) else if exist "%PROJECT_DIR%chatgpt-bridge\bun.exe" (
  set "BUN_CMD=%PROJECT_DIR%chatgpt-bridge\bun.exe"
) else (
  where bun >nul 2>nul && set "BUN_CMD=bun"
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

:: 2. Check / Install Bridge dependencies
if not exist "%PROJECT_DIR%chatgpt-bridge\node_modules" (
  echo [INFO] Dang cai dat dependencies cho ChatGPT Bridge...
  pushd "%PROJECT_DIR%chatgpt-bridge"
  call "%BUN_CMD%" install
  popd
)

echo [Huong dan]:
echo 1. Cua so trinh duyet se duoc bat len de ban dang nhap tai khoan ChatGPT.
echo 2. Dang nhap vao toi giao dien chat ChatGPT (chuan bi san sang).
echo 3. Sau do, hay DONG CUA SO TRINH DUYET lai.
echo 4. Terminal se tu dong dong bo phien va luu vao storage-state.json.
echo.

cd /d "%PROJECT_DIR%chatgpt-bridge"
call "%BUN_CMD%" run src/cli.ts --login %*

echo.
if %ERRORLEVEL% EQU 0 (
  echo ============================================================
  echo   [THANH CONG] Dang nhap va dong bo phien hoan tat!
  echo   Bay gio ban co the chay Start-All.bat de tao anh.
  echo ============================================================
) else (
  echo ============================================================
  echo   [THONG BAO] Dang nhap chua hoan tat hoac bi huy.
  echo ============================================================
)
echo.
pause
