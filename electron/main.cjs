// HTML-ZtEdit Electron 主进程
// 思路：用 Node 内置 http 把构建好的 dist/ 作为本地静态服务托管，
// 再用 BrowserWindow 加载 http://127.0.0.1:<port>/ ，避免 file:// 下
// ES 模块 / blob URL / iframe 的兼容问题。

const { app, BrowserWindow, ipcMain, dialog, session } = require('electron')
const http = require('http')
const fs = require('fs')
const path = require('path')

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

  win.loadURL(url)
  // 调试时取消下一行注释可按 F12 打开开发者工具
  // win.webContents.openDevTools()
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

function registerIpc() {
  ipcMain.handle('zt:open-html-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const picked = await pickHtmlAndFolder(win)
    if (!picked) return { canceled: true }
    const rootAbs = path.dirname(picked.htmlAbs)
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

  // 录屏：保存视频文件（渲染进程录好 blob 后传 ArrayBuffer 过来落盘）
  ipcMain.handle('zt:save-recording', async (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const { data, ext, suggestedName } = payload || {}
    if (!data) return { canceled: true, error: '无数据' }
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    const result = await dialog.showSaveDialog(win, {
      title: '保存录屏视频',
      defaultPath: suggestedName || `录屏-${stamp}.${ext || 'webm'}`,
      filters: [{ name: '视频文件', extensions: [ext || 'webm'] }],
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    try {
      fs.writeFileSync(result.filePath, Buffer.from(data))
      return { canceled: false, filePath: result.filePath }
    } catch (e) {
      return { canceled: true, error: String(e && e.message) }
    }
  })
}

// ------------------------------------------------------------

app.whenReady().then(() => {
  registerIpc()
  // 录屏：getDisplayMedia 直接捕获本窗口的页面内容（不含标题栏，无需用户选窗口）
  // 注意：Electron 29+ 要求 video 是 WebFrameMain 或 DesktopCapturerSource，不能传 webContents
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && win.webContents.mainFrame) callback({ video: win.webContents.mainFrame })
    else callback({})
  })
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
