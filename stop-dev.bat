@echo off
REM ============================================================
REM  ztEdit dev cleanup - free Vite ports 5173-5179 + Electron
REM
REM  Pure cmd (netstat + taskkill) on purpose, no PowerShell:
REM  this repo lives under a path with non-ASCII chars, and passing
REM  such a path to "powershell -File" is unreliable - the old version
REM  silently did nothing (SilentlyContinue + pause >nul hid it).
REM
REM  NOTE: keep this file ASCII-only. cmd.exe reads batch files with
REM  the local code page, so any non-ASCII byte can become garbage.
REM ============================================================
setlocal EnableDelayedExpansion
pushd "%~dp0"

echo ==========================================
echo   ztEdit dev cleanup
echo ==========================================
echo.

echo [1/3] Freeing Vite port range 5173-5179 ...
set FOUND=0
for /L %%P in (5173,1,5179) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr /R /C:":%%P .*LISTENING"') do (
    if not "%%A"=="0" (
      echo     port %%P -> killing PID %%A
      taskkill /PID %%A /F >nul 2>nul
      set FOUND=1
    )
  )
)
if "%FOUND%"=="0" echo     no listener found on 5173-5179

echo.
echo [2/3] Killing electron.exe ...
tasklist /FI "IMAGENAME eq electron.exe" 2>nul | findstr /I "electron.exe" >nul
if errorlevel 1 (
  echo     no electron process
) else (
  taskkill /IM electron.exe /F >nul 2>nul
  echo     electron.exe terminated
)

echo.
echo [3/3] dev-runner (node electron/dev-runner.cjs) ...
echo     NOT killed on purpose: killing every node.exe would also take
echo     down unrelated node projects/services you may have running.
echo     Step 1 already freed the port, which is what blocks startup.
echo     If the dev-runner console window is still open, just close it.

echo.
echo --- verify ---
netstat -ano | findstr /R /C:":5173 .*LISTENING" >nul
if errorlevel 1 (
  echo [OK] port 5173 is free now.
) else (
  echo [WARN] port 5173 still in use - close that window manually.
)
echo.
echo Done. Press any key to exit.
pause >nul
popd
