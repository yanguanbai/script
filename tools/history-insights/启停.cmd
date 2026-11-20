@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 双击一次：没在跑就启动并打开报告；已在跑就停掉。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0service.ps1" -Action toggle
if errorlevel 1 pause
ping -n 2 127.0.0.1 >nul
