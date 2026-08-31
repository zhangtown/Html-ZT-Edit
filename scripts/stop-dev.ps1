# ztEdit 调试进程释放脚本（由 stop-dev.bat 调用，也可直接 powershell -File 运行）
# 覆盖：Vite 端口段 5173-5179（5173 被占时 Vite 会自动顺延到 5174/5175...，只清 5173 会漏）
#       + electron.exe 调试窗口 + 本仓库的 vite/dev-runner node 进程
$ErrorActionPreference = 'SilentlyContinue'
$repo = Split-Path -Parent $PSScriptRoot

Write-Output '[1] 释放 Vite 端口段 5173-5179 ...'
$pids = @{}
foreach ($p in 5173..5179) {
  $conns = Get-NetTCPConnection -LocalPort $p -State Listen
  if ($conns) {
    foreach ($procId in ($conns | Select-Object -ExpandProperty OwningProcess -Unique)) {
      if ($procId -and $procId -ne 0 -and -not $pids.ContainsKey($procId)) {
        $pids[$procId] = $true
        $name = (Get-Process -Id $procId).Name
        Stop-Process -Id $procId -Force
        Write-Output ("    端口 {0} → PID {1} ({2}) 已结束" -f $p, $procId, $name)
      }
    }
  }
}
if ($pids.Count -eq 0) { Write-Output '    5173-5179 无监听进程' }

Write-Output '[2] 结束 electron.exe 调试进程 ...'
$e = Get-Process -Name electron -ErrorAction SilentlyContinue
if ($e) { $e | Stop-Process -Force; Write-Output ("    已结束 {0} 个 electron 进程" -f $e.Count) }
else { Write-Output '    无 electron 进程' }

Write-Output '[3] 结束本仓库的 vite / dev-runner node 进程 ...'
$nodes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($repo) -and
                 ($_.CommandLine.Contains('vite') -or $_.CommandLine.Contains('dev-runner')) }
if ($nodes) {
  foreach ($n in $nodes) { Stop-Process -Id $n.ProcessId -Force; Write-Output ("    PID {0} 已结束" -f $n.ProcessId) }
} else { Write-Output '    无匹配进程' }

Write-Output ''
Write-Output '完成：Vite 端口段 / Electron / 本仓库调试 node 进程已释放。'
