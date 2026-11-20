@echo off
rem Double-click entry: starts the local service and opens the report with the newest backup.
rem Keep this file ASCII-only: cmd reads batch files as GBK, so a Chinese path here would break silently.
cd /d "%~dp0tools\history-insights"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found. Install it from https://nodejs.org and double-click this file again.
  pause
  exit /b 1
)

node server.mjs --open
if errorlevel 1 pause
