@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found. Install it from https://nodejs.org and double-click this file again.
  pause
  exit /b 1
)

node server.mjs --open
if errorlevel 1 pause
