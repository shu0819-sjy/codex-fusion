@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0start-codex-fusion.ps1" %*
endlocal
