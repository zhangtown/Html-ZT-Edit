@echo off
REM ztEdit debug cleanup: Vite ports 5173-5179 + Electron + repo node processes
REM (Chinese messages live in scripts/stop-dev.ps1 to avoid cmd encoding traps)

where powershell >nul 2>nul || (echo [Error] PowerShell not found && goto :end)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-dev.ps1"

:end
pause >nul
