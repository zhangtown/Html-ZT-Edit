@echo off
chcp 65001 >nul
echo ========================================
echo   HTML-ZtEdit 调试服务释放脚本
echo ========================================
echo.

echo [1] 关闭 5173 端口 (Vite dev server)...
powershell -NoProfile -Command "$ps = Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess; if ($ps) { $ps | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; echo ('  已结束进程 PID: ' + ($ps -join ', ')) } else { echo '  端口 5173 未被占用' }"

echo [2] 关闭 Electron 调试窗口进程...
taskkill /IM electron.exe /F >nul 2>&1 && echo "  已结束 electron.exe" || echo "  无 electron 进程"

echo [3] 关闭 dev-runner 父进程 (npm run dev:electron 启动的 node)...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe' AND CommandLine LIKE '%dev-runner%'\" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; echo ('  已结束 dev-runner PID: ' + $_.ProcessId) }"

echo.
echo ========================================
echo  完成。端口 5173 与 Electron 已释放。
echo ========================================
pause >nul
