@echo off
setlocal
rem Start Tauri dev mode from this script's location (portable)
cd /d "%~dp0host"
call npm run dev
