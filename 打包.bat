@echo off
setlocal EnableExtensions
pushd "%~dp0"

echo =====================================================
echo  HTML-ZT-Edit  Windows one-click build (Electron exe)
echo =====================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [Error] Node.js not found. Install Node.js LTS 18+ and add to PATH.
  goto :end
)
where npm >nul 2>nul
if errorlevel 1 (
  echo [Error] npm not found. Install Node.js LTS 18+.
  goto :end
)

for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
for /f "tokens=*" %%i in ('npm -v') do set NPM_VER=%%i
echo [env] Node %NODE_VER%   npm %NPM_VER%
echo.

REM --- domestic mirrors: session only, not global ---
set "npm_config_registry=https://registry.npmmirror.com/"
set "ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/"
set "NODE_TLS_REJECT_UNAUTHORIZED=0"

REM --- disable code signing: skip WinCodeSign download (mirror 404 before) ---
set "CSC_IDENTITY_AUTO_DISCOVERY=false"
set "CSC_LINK="

REM --- step 1: npm install (skip electron binary to avoid EBUSY lock) ---
set "ELECTRON_SKIP_BINARY_DOWNLOAD=1"
echo [1/4] npm install (electron binary skipped) ...
call npm install --no-audit --no-fund
set NPM_ERR=%errorlevel%
set "ELECTRON_SKIP_BINARY_DOWNLOAD="
if %NPM_ERR% neq 0 (
  echo [Warn] npm install returned %NPM_ERR%. Will continue; electron-builder fetches its own runtime.
)

REM --- step 2: explicitly download electron runtime via mirror ---
echo [2/4] download electron runtime ...
if exist "node_modules\electron\dist\electron.exe" (
  echo electron.exe already present, skip.
) else (
  call node node_modules/electron/install.js
  if errorlevel 1 (
    echo [Error] electron runtime download failed. Check network / mirror.
    goto :end
  )
)

REM --- step 3: build and package ---
echo [3/4] npm run electron:build (vite build + electron-builder) ...
call npm run electron:build
if errorlevel 1 (
  echo [Error] electron:build failed.
  goto :end
)

echo [4/4] Build complete.
echo Output folder: dist-electron
echo File: HTML-ZT-Edit.exe

:end
popd
echo.
echo Press any key to close this window ...
pause >nul
