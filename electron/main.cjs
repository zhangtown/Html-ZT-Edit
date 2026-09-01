// HTML-ZtEdit Electron 主进程
// 思路：用 Node 内置 http 把构建好的 dist/ 作为本地静态服务托管，
// 再用 BrowserWindow 加载 http://127.0.0.1:<port>/ ，避免 file:// 下
// ES 模块 / blob URL / iframe 的兼容问题。

const { app, BrowserWindow, ipcMain, dialog, session, screen } = require('electron')
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
    try {
      if (mainWin && !mainWin.isDestroyed()) {
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
    } catch (e) { /* 拿不到就让控制器走默认值 */ }
    try { return await obsRecorder.start(a) } catch (e) { return { ok: false, error: String(e && e.message) } }
  })

  ipcMain.handle('zt:obs-stop', async () => {
    try { return await obsRecorder.stop() } catch (e) { return { ok: false, error: String(e && e.message) } }
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
