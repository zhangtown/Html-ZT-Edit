// HTML-ZtEdit Electron 主进程
// 思路：用 Node 内置 http 把构建好的 dist/ 作为本地静态服务托管，
// 再用 BrowserWindow 加载 http://127.0.0.1:<port>/ ，避免 file:// 下
// ES 模块 / blob URL / iframe 的兼容问题。

const { app, BrowserWindow, ipcMain, dialog, session, screen } = require('electron')
// 防御：若 ELECTRON_RUN_AS_NODE=1 被置位，electron.exe 会以纯 Node 模式运行，
// require('electron') 只返回可执行文件路径字符串，app 解构为 undefined。
// 给出明确诊断而非第 14 行的裸 TypeError。
if (!app || typeof app.commandLine !== 'object') {
  console.error('[main] require("electron") 未返回 Electron API（app 缺失）。')
  console.error('[main] 可能原因：ELECTRON_RUN_AS_NODE 被置位，或 main.cjs 被纯 Node 直接执行。')
  console.error('[main] 请改用 npm run dev:electron / start-dev.bat 启动。')
  process.exit(1)
}
// OBS 录制后端（方案 A）：系统级录屏，主进程只经 obs-websocket 触发起停。
// 依赖在连接时才 lazy require，缺依赖不会拖垮编辑器启动。
const obsRecorder = require('./obsRecorder.cjs')

// 录屏必需：禁止 Chromium 在窗口被遮挡 / 切到后台时停止渲染、挂起 rAF、降频计时器。
// 不关掉这三项，用户一切到 OBS 去看画面，ztEdit 窗口就被判定为"不可见"而停止绘制，
// OBS 的窗口捕获抓到的永远是同一帧 —— 成片就变成一张静止图（还常伴声音丢失）。
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')
const { spawn, spawnSync } = require('child_process')

let mainWin = null // 主编辑器窗口

// 打包后 app.getAppPath() 指向 resources/app；开发时指向项目根
function getDistDir() {
  return path.join(app.getAppPath(), 'dist')
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

function createServer(distDir) {
  return http.createServer((req, res) => {
    try {
      let urlPath = decodeURIComponent((req.url || '/').split('?')[0])
      if (urlPath === '/') urlPath = '/index.html'
      const filePath = path.normalize(path.join(distDir, urlPath))
      // 防目录穿越
      if (filePath !== distDir && !filePath.startsWith(distDir + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Forbidden')
        return
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('Not Found')
          return
        }
        const ext = path.extname(filePath).toLowerCase()
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        })
        res.end(data)
      })
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Server Error')
    }
  })
}

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1366,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'HTML-ZtEdit',
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })

  // 开发者工具：F12 或 Ctrl+Shift+I 开合。
  // Electron 的默认菜单并不保证带这些快捷键，所以在输入到达页面之前显式拦一道最稳。
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const k = String(input.key || '').toLowerCase()
    if (k === 'f12' || (input.control && input.shift && k === 'i')) {
      win.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  win.loadURL(url)
  mainWin = win
  return win
}

// ------------------------------------------------------------
// IPC：选择 HTML 文件 → 返回该文件所在文件夹的全部资源清单
// ------------------------------------------------------------

// 参与归档的资源后缀（HTML 幻灯片常用到的图片/媒体/样式/脚本/字体）
const ARCHIVE_EXTS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.json',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac',
  '.mp4', '.webm', '.mov', '.m4v',
])
// 超过该大小的文件跳过（避免把超大视频读进内存）
const MAX_FILE_BYTES = 150 * 1024 * 1024
// 需要跳过的目录
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron'])

// 递归收集 folder 下所有参与归档的文件，返回 { relPath, absPath, name, size }
function collectFolderFiles(folder) {
  const rootAbs = path.resolve(folder)
  const out = []
  function walk(dir, relBase) {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      return
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name)
      const rel = relBase ? relBase + '/' + ent.name : ent.name
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue
        walk(abs, rel)
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase()
        if (!ARCHIVE_EXTS.has(ext)) continue
        let size = 0
        try {
          size = fs.statSync(abs).size
        } catch (e) {}
        if (size > MAX_FILE_BYTES) continue
        out.push({ relPath: rel, absPath: abs, name: ent.name, size })
      }
    }
  }
  walk(rootAbs, '')
  return out
}

// 原生文件框：筛选 html，选中的是主 HTML。返回它的绝对路径及其所在文件夹名。
async function pickHtmlAndFolder(win) {
  const result = await dialog.showOpenDialog(win, {
    title: '选择 HTML 文件（将加载其所在文件夹的全部资源）',
    properties: ['openFile'],
    filters: [{ name: 'HTML 文件', extensions: ['html', 'htm'] }],
  })
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return null
  }
  const htmlAbs = result.filePaths[0]
  return {
    htmlAbs,
    rootName: path.basename(path.dirname(htmlAbs)),
    mainHtmlName: path.basename(htmlAbs),
  }
}

// ------------------------------------------------------------
// 录制上下文（仅 OBS 全自动路线使用）
// ------------------------------------------------------------
let recRoot = '' // 当前编辑 HTML 所在文件夹的绝对路径（OBS 成片就落在这里）

function registerIpc() {
  ipcMain.handle('zt:open-html-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const picked = await pickHtmlAndFolder(win)
    if (!picked) return { canceled: true }
    const rootAbs = path.dirname(picked.htmlAbs)
    // 记下资源根目录：相对资源改写成绝对地址要用，OBS 成片也落在它里面
    recRoot = rootAbs
    const files = collectFolderFiles(rootAbs)
    return { canceled: false, ...picked, files }
  })

  ipcMain.handle('zt:read-file-b64', (event, absPath) => {
    try {
      const buf = fs.readFileSync(absPath)
      return { ok: true, data: buf.toString('base64') }
    } catch (e) {
      return { ok: false, error: String(e && e.message) }
    }
  })

  // 资源根目录（当前编辑 HTML 所在文件夹的绝对路径）——OBS 成片落点
  ipcMain.handle('zt:get-root', () => ({ root: recRoot || '' }))

  // 从草稿恢复时回填根目录：否则刷新页面后拿不到 HTML 所在目录，成片不知道该存哪
  ipcMain.handle('zt:set-root', (event, root) => {
    recRoot = typeof root === 'string' ? root : ''
    return { root: recRoot }
  })

  // ------------------------------------------------------------
  // 临时 HTML 落盘 + 系统浏览器打开（脱离 ztEdit 录制）
  // ------------------------------------------------------------
  let tempRecFile = ''        // 本次录制落盘的临时 HTML 绝对路径（录制结束删除）
  let browserChild = null     // 打开临时 HTML 的浏览器进程

  // 定位系统浏览器：优先 Edge，其次 Chrome。用于「脱离 ztEdit」录制模式。
  function resolveBrowserExe() {
    const cand = [
      process.env.BROWSER_EXE,
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      '%ProgramFiles(x86)%/Microsoft/Edge/Application/msedge.exe',
      '%ProgramFiles%/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ]
    for (const raw of cand) {
      if (!raw) continue
      const p = raw.indexOf('%') >= 0
        ? raw.replace(/%ProgramFiles\(x86\)%/gi, process.env['ProgramFiles(x86)'] || '').replace(/%ProgramFiles%/gi, process.env.ProgramFiles || '')
        : raw
      if (p && fs.existsSync(p)) return p
    }
    return ''
  }

  // 向浏览器窗口发送「真实空格键」：这是用户手势，能解锁浏览器自动播放策略下被拦的音频。
  // 纯前端 dispatchEvent 不算手势、会被拦成无声，所以必须用真实按键（SendKeys）。
  function sendInteract(title) {
    if (process.platform !== 'win32') return
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      "$ws = New-Object -ComObject WScript.Shell",
      "$ws.AppActivate('" + String(title || '').replace(/'/g, "''") + "')",
      'Start-Sleep -Milliseconds 300',
      "[System.Windows.Forms.SendKeys]::SendWait(' ')",
    ].join('; ')
    try { spawnSync('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 6000 }) } catch (e) {}
  }

  // 关闭浏览器 + 删除临时文件（手动停止或浏览器自己关掉时都走这里）。
  function closeBrowserAndCleanup() {
    if (browserChild && !browserChild.killed) {
      try { spawnSync('taskkill', ['/PID', String(browserChild.pid), '/T', '/F'], { windowsHide: true }) } catch (e) {}
      browserChild = null
    }
    if (tempRecFile) {
      try { fs.unlinkSync(tempRecFile) } catch (e) {}
      tempRecFile = ''
    }
  }

  // ------------------------------------------------------------
  // OBS 录制后端：连接 OBS → 全自动起录 / 停止 → 查状态
  // 渲染端 window.ztRecSession.startOBS/stopOBS/obsStatus 对应此处
  // ------------------------------------------------------------
  ipcMain.handle('zt:obs-connect', async () => {
    try { const r = await obsRecorder.connect(); return r } catch (e) { return { ok: false, error: String(e && e.message) } }
  })

  // 全自动起录。渲染端只需给 outdir；窗口标题与全屏尺寸由主进程补齐——
  // 这两样只有主进程知道（渲染进程拿不到自己的原生窗口句柄/所在显示器）。
  ipcMain.handle('zt:obs-start', async (event, opts) => {
    const a = Object.assign({}, opts || {})
    let writtenTempFile = '' // 本次落盘的临时 HTML 绝对路径（回传渲染端用于显示/排错）
    try {
      // 浏览器模式：把内存 HTML 落盘到源目录的临时文件，用系统浏览器全屏打开，
      // OBS 捕获的是浏览器窗口（不再是 ztEdit 编辑界面），最小化 ztEdit 也不影响录制。
      if (a.captureMode === 'obs-browser-source') {
        // OBS 原生浏览器源：把内存 HTML 落盘为稳定文件「录屏源.html」，交给 OBS 内置 CEF 渲染。
        // 不打开系统浏览器窗口、不依赖窗口捕获；文件持久保留（区别于浏览器窗口模式的临时文件会被删除）。
        const outdir = a.outdir ? path.resolve(a.outdir) : ''
        if (!outdir) return { ok: false, error: '没有拿到 HTML 所在目录，无法落盘浏览器源文件。请先「选择 HTML 文件」。' }
        try { fs.mkdirSync(outdir, { recursive: true }) } catch (e) {}
        const stableFile = path.join(outdir, '录屏源.html')
        let html = a.html || ''
        if (!/<title>/i.test(html)) {
          if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, '$&<title>ZT录屏源</title>')
          else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, '$&<head><title>ZT录屏源</title></head>')
          else html = '<head><title>ZT录屏源</title></head>' + html
        }
        const delayMs = a.interactDelaySec > 0 ? Math.max(300, Math.round(a.interactDelaySec * 1000)) : 0
        if (delayMs) html = html.replace(/setTimeout\(\s*startPlayback\s*,\s*\d+\s*\)/, 'setTimeout(startPlayback, ' + delayMs + ')')
        fs.writeFileSync(stableFile, html, 'utf8')
        writtenTempFile = stableFile // 复用回传通道：UI 显示路径；此文件不删，录完仍在项目目录
        a.browserUrl = pathToFileURL(stableFile).href
        a.width = a.width || 1920
        a.height = a.height || 1080
      } else if (a.captureMode === 'browser') {
        const outdir = a.outdir ? path.resolve(a.outdir) : ''
        if (!outdir) return { ok: false, error: '没有拿到 HTML 所在目录，无法落盘临时文件。请先「选择 HTML 文件」。' }
        try { fs.mkdirSync(outdir, { recursive: true }) } catch (e) {}
        const tempName = 'ZT录屏临时.html'
        const tempFile = path.join(outdir, tempName)
        // 确保临时文件有稳定 <title>：Edge 全屏窗口标题=页面 title，OBS 识别 + SendKeys 激活都依赖它。
        let html = a.html || ''
        if (!/<title>/i.test(html)) {
          if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, '$&<title>ZT录屏临时</title>')
          else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, '$&<head><title>ZT录屏临时</title></head>')
          else html = '<head><title>ZT录屏临时</title></head>' + html
        }
        // 音频开始延迟：把生成引擎的 `setTimeout(startPlayback, 300)` 延后到 delayMs，
        // 进画面先放首屏 / CSS 入场动画，N 毫秒后再出音频（避免一进画面就爆音、观众没准备）。
        // 引擎动画时间轴与音频时间轴绑死（loop 读 audio.currentTime），只能整体延后 startPlayback。
        const delayMs = a.interactDelaySec > 0 ? Math.max(300, Math.round(a.interactDelaySec * 1000)) : 0
        if (delayMs) html = html.replace(/setTimeout\(\s*startPlayback\s*,\s*\d+\s*\)/, 'setTimeout(startPlayback, ' + delayMs + ')')
        fs.writeFileSync(tempFile, html, 'utf8')
        tempRecFile = tempFile
        writtenTempFile = tempFile
        const bExe = resolveBrowserExe()
        if (!bExe) return { ok: false, error: '未找到系统浏览器（Edge/Chrome），无法脱离 ztEdit 播放。请安装 Edge 或 Chrome。' }
        // 关键：用 pathToFileURL 正确百分号编码路径。源目录含中文 / 全角标点（如 `D:\11、codefile\测试工程`）
        // 时，裸 `file:///` + 字符串替换生成的 URL 在 Edge 里经常加载失败 → 浏览器开了但白屏不播放。
        const fileUrl = pathToFileURL(tempFile).href
        browserChild = spawn(bExe, ['--app=' + fileUrl, '--new-window', '--start-fullscreen'], {
          detached: true, stdio: 'ignore', windowsHide: false,
        })
        // 浏览器窗口被用户关掉 → 自动收尾（停 OBS + 删临时文件 + 通知渲染端）。
        browserChild.on('exit', () => {
          if (!tempRecFile && !browserChild) return
          try {
            obsRecorder.stop().then((r) => {
              if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('zt:obs-browser-closed', r || {})
            }).catch(() => {})
          } catch (e) {}
          if (tempRecFile) { try { fs.unlinkSync(tempRecFile) } catch (e) {} tempRecFile = '' }
          browserChild = null
        })
        a.windowTitle = 'ZT录屏临时' // 让 OBS 按此标题捕获 Edge 窗口
      } else if (mainWin && !mainWin.isDestroyed()) {
        if (!a.windowTitle) a.windowTitle = mainWin.getTitle() || 'HTML-ZtEdit'
        // 兜底尺寸：窗口的「物理像素」尺寸（逻辑尺寸 × 系统缩放）。
        // 绝不能用整块显示器尺寸——捕获的是窗口，窗口通常比显示器小，
        // 拿显示器尺寸当画布会让 OBS 把窗口放大铺满 → 成片异常模糊。
        // 真正的画布由控制器直接问 OBS 源的真实像素尺寸，这里只作后备值。
        const b = mainWin.getBounds()
        const d = screen.getDisplayMatching(b)
        const sf = (d && d.scaleFactor) || 1
        a.width = Math.round(b.width * sf)
        a.height = Math.round(b.height * sf)
      }
      const r = await obsRecorder.start(a)
      // 把临时文件路径回传渲染端，方便用户在录制中 / 排错时直接定位文件（注意：浏览器关闭后会自动删除）。
      if (writtenTempFile) try { r = Object.assign({}, r, { tempFile: writtenTempFile }) } catch (e) {}
      // 延迟兜底：延迟期间向浏览器窗口发一次真实空格键。file:// 下引擎已按 delayMs 自动起播，
      // 这里主要作为「自动播放策略万一拦住音频」的兜底手势（真实按键算用户手势，可解锁）。
      // 与上面的 startPlayback 延后同源，时间点一致、且 startPlayback 内部 `if(isPlaying)return` 幂等。
      if (r && r.ok && a.captureMode === 'browser' && a.interactDelaySec > 0) {
        setTimeout(() => { sendInteract('ZT录屏临时') }, Math.round(a.interactDelaySec * 1000))
      }
      return r
    } catch (e) { return { ok: false, error: String(e && e.message) } }
  })

  ipcMain.handle('zt:obs-stop', async () => {
    try {
      const r = await obsRecorder.stop()
      closeBrowserAndCleanup() // 关浏览器 + 删临时文件
      return r
    } catch (e) { return { ok: false, error: String(e && e.message) } }
  })

  ipcMain.handle('zt:obs-status', async () => {
    try { return await obsRecorder.status() } catch (e) { return { connected: obsRecorder.isConnected(), error: String(e && e.message) } }
  })
}

// ------------------------------------------------------------

app.whenReady().then(() => {
  registerIpc()
  // 开发调试模式：通过 VITE_DEV_SERVER_URL 直接加载 Vite dev server（HMR 热更新）
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    createWindow(devUrl)
    return
  }

  const distDir = getDistDir()
  if (!fs.existsSync(distDir)) {
    console.error('未找到 dist 目录，请先执行 npm run build')
    app.exit(1)
    return
  }
  const server = createServer(distDir)
  // 使用随机空闲端口，避免端口冲突
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    createWindow(`http://127.0.0.1:${port}/`)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
})
