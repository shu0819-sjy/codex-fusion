@echo off
setlocal

set "APP_EXE=C:\codex-fusion\host\src-tauri\target\release\codex-fusion-host.exe"

if not exist "%APP_EXE%" (
  echo 未找到生产版程序：%APP_EXE%
  echo 请先在 C:\codex-fusion\host 执行 npm run build
  pause
  exit /b 1
)

start "Codex Fusion" "%APP_EXE%"
endlocal
