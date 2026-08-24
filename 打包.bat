@echo off
setlocal

REM ============================================================
REM HTML-ZT-Edit  one-click Windows build (Electron desktop exe)
REM Double-click to run. Dependencies and the Electron binary
REM are fetched from domestic mirrors to avoid slow or stuck
REM GitHub downloads behind a corporate proxy.
REM ============================================================

pushd "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [Error] Node.js not found. Please install Node.js LTS 18 plus and add to PATH.
  goto :end
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [Error] npm not found.
  goto :end
)

for /f "tokens=*" %%i in ('node -v') do echo [env] Node %%i
for /f "tokens=*" %%i in ('npm -v') do echo [env] npm %%i
echo.

REM --- domestic mirrors: fix slow or stuck download ---
set "npm_config_registry=https://registry.npmmirror.com"
set "ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binary/"
set "NODE_TLS_REJECT_UNAUTHORIZED=0"

echo [1/3] npm install with domestic mirror ...
call npm install
if errorlevel 1 (
  echo [Error] npm install failed.
  goto :end
)
echo.

echo [2/3] npm run electron:build ...
call npm run electron:build
if errorlevel 1 (
  echo [Error] electron:build failed.
  goto :end
)
echo.

echo [3/3] Build complete.
echo Output folder: dist-electron
echo Look for file: HTML-ZT-Edit.exe

:end
popd
pause
