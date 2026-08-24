@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================================
echo   HTML-ZtEdit  One-click Build
echo   Step 1: npm install      Step 2: npm run build
echo   Output: dist\  (deploy to any static server)
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [Error] Node.js not found. Please install Node.js LTS 18+ and add it to PATH.
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

echo [1/2] Installing dependencies (npm install) ...
call npm install
if errorlevel 1 (
  echo [Error] npm install failed. Check network or npm config.
  goto :end
)
echo.

echo [2/2] Building production bundle (npm run build) ...
call npm run build
if errorlevel 1 (
  echo [Error] build failed.
  goto :end
)
echo.

echo ============================================================
echo   Done! Output folder: %cd%\dist
echo   Deploy: upload the contents of dist\ to any static server
echo            (Nginx / Vercel / GitHub Pages / CDN).
echo   SPA note: set history fallback so refresh returns index.html.
echo ============================================================

:end
pause
