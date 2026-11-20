@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Prefer a Node that is already on PATH; fall back to the usual install folder.
where node >nul 2>&1
if errorlevel 1 if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found on this computer.
  echo Install the LTS build ^(https://nodejs.org/zh-cn/download^), or use the Setup.exe release
  echo which ships its own Node runtime and needs nothing preinstalled.
  start "" "https://nodejs.org/zh-cn/download"
  pause
  exit /b 1
)

node server.mjs --open
if errorlevel 1 pause