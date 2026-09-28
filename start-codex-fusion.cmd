@echo off
setlocal

rem Resolve repo root from this script's location (portable, no hard-coded path)
set "SCRIPT_DIR=%~dp0"
set "APP_EXE=%SCRIPT_DIR%host\src-tauri\target\release\codex-fusion-host.exe"

if not exist "%APP_EXE%" (
  echo 未找到生产版程序：%APP_EXE%
  echo 请先构建：cd host ^&^& npm install ^&^& cd src-tauri ^&^& cargo build --release
  pause
  exit /b 1
)

start "Codex Fusion" "%APP_EXE%"
endlocal
