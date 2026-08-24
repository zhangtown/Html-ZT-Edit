@echo off
chcp 65001 >nul
setlocal
rem 切换到本批处理文件所在目录，无论从哪里双击都能正确执行
cd /d "%~dp0"

echo ============================================================
echo   HTML-ZtEdit 一键打包
echo   步骤：安装依赖 (npm install) + 构建生产包 (npm run build)
echo   产出：dist\ 目录（可直接部署到任意静态服务器）
echo ============================================================
echo.

rem --- 环境检查 ---
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js。请先安装 Node.js（建议 LTS 18+）并确保已加入 PATH。
  goto :end
)
where npm >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 npm。
  goto :end
)

for /f "tokens=*" %%i in ('node -v') do echo [环境] Node %%i
for /f "tokens=*" %%i in ('npm -v') do echo [环境] npm %%i
echo.

rem --- 1. 安装依赖 ---
echo [1/2] 安装依赖 (npm install) ...
call npm install
if errorlevel 1 (
  echo [错误] 依赖安装失败，请检查网络或 npm 配置。
  goto :end
)
echo.

rem --- 2. 构建生产包 ---
echo [2/2] 构建生产包 (npm run build) ...
call npm run build
if errorlevel 1 (
  echo [错误] 构建失败。
  goto :end
)
echo.

echo ============================================================
echo  打包完成！
echo  产出目录：%cd%\dist
echo  部署方式：将 dist\ 下所有文件上传到任意静态服务器
echo            （Nginx / Vercel / GitHub Pages / CDN 均可），
echo            因是 SPA，请配置 history fallback（刷新回 index.html）。
echo ============================================================

:end
pause
