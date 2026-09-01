@echo off
setlocal EnableExtensions
pushd "%~dp0"
chcp 65001 >nul

echo ========================================
echo   HTML-ZtEdit 一键启动调试 (dev:electron)
echo ========================================
echo.

where node >nul 2>nul || (echo [Error] 未找到 Node.js，请先安装 LTS 18+ && goto :end)
where npm  >nul 2>nul || (echo [Error] 未找到 npm && goto :end)

REM --- 国内镜像（仅本次会话，不污染全局配置）---
set "npm_config_registry=https://registry.npmmirror.com/"
set "ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/"
set "NODE_TLS_REJECT_UNAUTHORIZED=0"

REM --- 1. 安装依赖（缺失时才装）---
if not exist "node_modules" (
  echo [1/3] 首次运行，安装依赖（可能较慢，已启用国内镜像）...
  call npm install --no-audit --no-fund
) else (
  echo [1/3] 依赖已存在，跳过 npm install
)

REM --- 2. 确保 Electron 依赖与运行时就绪 ---
REM 顺序很关键：node_modules 存在不代表 electron 装了（clone 后部分安装失败就是这种）。
REM 只判断 electron.exe 就去跑 install.js，而那个文件本身压根不存在，会直接报错退出。
if not exist "node_modules\electron\package.json" (
  echo [2/3] Electron 依赖缺失，补装（已启用国内镜像）...
  call npm install --no-audit --no-fund
) else if not exist "node_modules\electron\dist\electron.exe" (
  echo [2/3] 下载 Electron 运行时 ...
  call node node_modules/electron/install.js
) else (
  echo [2/3] Electron 运行时已存在，跳过下载
)

REM --- Auto-release stale Vite listeners (5173-5179) before starting. ---
REM Vite auto-shifts to 5174/5175 when 5173 is taken, so clean the whole range.
REM ASCII-only block: non-ASCII in a .bat is read as GBK and can break parsing.
for /L %%P in (5173,1,5179) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr /R /C:":%%P .*LISTENING"') do (
    if not "%%A"=="0" (
      echo [auto] port %%P busy, killing PID %%A ...
      taskkill /PID %%A /F >nul 2>nul
    )
  )
)

REM --- 3. 启动调试 ---
echo [3/3] 启动 dev:electron（Vite + Electron，改 src/ 自动热更新）...
echo 提示：窗口内按 F12（或 Ctrl+Shift+I）开关 DevTools；关闭窗口或 Ctrl+C 结束；
echo       若进程残留，再运行 stop-dev.bat 一键释放。
echo.
call npm run dev:electron

:end
echo.
echo Finished. Press any key to close this window.
popd
pause >nul
