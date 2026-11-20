@echo off
rem Repo-root toggle: double-click to start the local service (and open the report), double-click again to stop it.
rem Keep this file ASCII-only: cmd reads batch files as GBK, so a Chinese path here would break silently.
cd /d "%~dp0tools\history-insights"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\history-insights\service.ps1" -Action toggle
if errorlevel 1 pause
ping -n 2 127.0.0.1 >nul
