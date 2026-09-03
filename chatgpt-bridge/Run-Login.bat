@echo off
title ChatGPT Image CLI - Dang Nhap
cd /d "%~dp0"
echo ===================================================
echo   Dang mo trinh duyet Chrome de dang nhap ChatGPT...
echo   Vui long dang nhap tren cua so Chrome vua mo.
echo ===================================================
bun run src/cli.ts --login
pause
