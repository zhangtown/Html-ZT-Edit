@echo off
setlocal

REM ============================================================
REM HTML-ZT-Edit  one-click Windows build (Electron desktop exe)
REM Double-click to run. Dependencies and the Electron binary
REM are fetched from domestic mirrors. Code signing is DISABLED
REM so the WinCodeSign binary is NOT required (the exe is
REM unsigned, which is fine for local/personal use).
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

REM --- domestic mirrors: valid for this session only, not global ---
set "npm_config_registry=https://registry.npmmirror.com/"
set "ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/"
set "NODE_TLS_REJECT_UNAUTHORIZED=0"

REM --- disable code signing: skips WinCodeSign download (404 before) ---
set "CSC_IDENTITY_AUTO_DISCOVERY=false"
set "CSC_LINK="

REM --- skip electron's own binary during npm install to avoid EBUSY ---
REM (electron-builder downloads its own runtime later via ELECTRON_MIRROR)
set "ELECTRON_SKIP_BINARY_DOWNLOAD=1"

echo [1/3] npm install with domestic mirror ...
call npm install --no-audit --no-fund
set NPM_ERR=%errorlevel%
set "ELECTRON_SKIP_BINARY_DOWNLOAD="
if %NPM_ERR% neq 0 (
  echo [Warn] npm install returned %NPM_ERR% (electron-builder will still fetch its own Electron binary).
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
