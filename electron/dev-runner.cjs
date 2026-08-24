// 开发调试启动器：同时启动 Vite dev server + Electron
// 用法：npm run dev:electron
// 效果：Electron 窗口直接加载 Vite dev server（http://localhost:5173），
//       改 src/ 代码 HMR 热更新，无需重新 build。
// 注意：electron/main.cjs 的改动需要重启本脚本才生效（主进程无 HMR）。

const { spawn } = require('child_process')
const path = require('path')

const root = path.join(__dirname, '..')
const VITE_PORT = 5173
const DEV_URL = `http://localhost:${VITE_PORT}`

// Windows 上 npx 需要 npx.cmd，用 shell:true 让系统解析
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

console.log('==========================================')
console.log(' HTML-ZtEdit 开发调试模式')
console.log('==========================================')
console.log(` Vite dev server : ${DEV_URL}`)
console.log(' 修改 src/ 下代码会自动热更新')
console.log(' 按 F12 打开 DevTools；关闭 Electron 窗口即退出')
console.log('==========================================')

const vite = spawn(npx, ['vite'], { cwd: root, stdio: 'inherit', shell: true })

let electron = null
function launchElectron() {
  if (electron) return
  electron = spawn(npx, ['electron', '.'], {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, VITE_DEV_SERVER_URL: DEV_URL },
  })
  electron.on('exit', () => {
    // Electron 退出即结束整个调试会话
    vite.kill()
    process.exit(0)
  })
}

// 等 Vite 就绪再启动 Electron（约 2.5s），失败则 10s 后重试
setTimeout(launchElectron, 2500)
vite.on('exit', (code) => {
  if (!electron) {
    console.error('Vite dev server 启动失败，请检查端口 5173 是否被占用')
    process.exit(code || 1)
  }
})

process.on('SIGINT', () => {
  if (vite) vite.kill()
  if (electron) electron.kill()
  process.exit(0)
})
