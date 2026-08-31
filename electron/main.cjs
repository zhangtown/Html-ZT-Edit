// HTML-ZtEdit Electron 主进程
// 思路：用 Node 内置 http 把构建好的 dist/ 作为本地静态服务托管，
// 再用 BrowserWindow 加载 http://127.0.0.1:<port>/ ，避免 file:// 下
// ES 模块 / blob URL / iframe 的兼容问题。

const { app, BrowserWindow, ipcMain, dialog, session, screen } = require('electron')
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
// 离屏录制窗口：定尺寸 + 隐藏，让录屏结果与编辑器窗口大小彻底解耦
// ------------------------------------------------------------
let recWin = null // 离屏录制窗口
let recRoot = '' // 当前编辑 HTML 所在文件夹绝对路径
let recTmpFile = null // 录屏用临时 HTML

// 注意：本页【不能静音】。录制时的音频轨就是从这个窗口捕获的（见 setDisplayMediaRequestHandler 的 audio 帧），
// 一旦静音就录不到声音。改为把编辑器内那份页面静音（由 App.jsx 在录制时处理），避免双声源。
const REC_GATE = `
<script>
/* zt rec-gate：拦住页面的自动播放，等 zt:rec-start 放行，
   好让离屏页与编辑器内的播放同时起步 */
(function(){
  var queue = [];
  var released = false;
  // 诊断埋点：静音排查时第一手要看的就是这几个数
  window.__ztDiag = { playCalls: 0, released: false, playOk: 0, playErr: [] };
  var origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function(){
    var self = this, args = arguments;
    window.__ztDiag.playCalls++;
    if (released) return origPlay.apply(self, args);
    return new Promise(function(resolve, reject){
      queue.push(function(){
        origPlay.apply(self, args).then(function(r){
          window.__ztDiag.playOk++;
          resolve(r);
        }, function(e){
          window.__ztDiag.playErr.push(String(e && e.message));
          reject(e);
        });
      });
    });
  };
  function release(){
    if (released) return;
    released = true;
    window.__ztDiag.released = true;
    var q = queue.slice(); queue.length = 0;
    q.forEach(function(fn){ try { fn(); } catch (e) {} });
    // 兜底起播：队列是空的，说明播放脚本压根没跑到 play()。
    // 典型场景是页面带大体积 video —— window 的 load 事件被拖着迟迟不触发，
    // 挂在 load 上的自动播放就永远排不上队：video 自己 autoplay 循环看着"画面在动"，
    // 但音频和整条时间轴压根没启动，录出来只有静音。
    if (q.length === 0) {
      setTimeout(function(){
        try {
          if (typeof window.startPlayback === 'function') {
            // 生成的播放脚本里 startPlayback 是全局函数，直接调能把翻页 loop 一起带起来
            window.startPlayback();
            window.__ztDiag.fallback = 'startPlayback';
          } else {
            // 页面脚本多为 IIFE，startPlayback 不可达。裸 audio.play() 只出声不翻页
            // （实测整段录像冻结在第一页）。模板脚本约定：首次点击 = startPlayback，
            // 模拟一次点击把 isPlaying/loop 一起带起来。
            document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            window.__ztDiag.fallback = 'click';
          }
          // 再兜一层：800ms 后音频仍是暂停态（页面没有 click 启动逻辑）才裸 play 保底出声
          setTimeout(function(){
            var a = document.getElementById('bgAudio') || document.querySelector('audio');
            if (a && a.paused) {
              var p = a.play();
              if (p && p.then) p.then(function(){ window.__ztDiag.playOk++; }).catch(function(e){
                window.__ztDiag.playErr.push(String(e && e.message));
              });
              window.__ztDiag.fallback2 = 'audio.play';
            }
          }, 800);
        } catch (e) { window.__ztDiag.fallbackErr = String(e && e.message); }
      }, 60);
    }
  }
  window.__ztRecRelease = release;
  if (window.ztRecCtl && window.ztRecCtl.onStart) {
    window.ztRecCtl.onStart(release);
  }
})();
<\/script>`

function withRecGate(html) {
  var i = html.search(/<head[^>]*>/i)
  if (i >= 0) {
    var m = html.match(/<head[^>]*>/i)
    var at = i + m[0].length
    return html.slice(0, at) + REC_GATE + html.slice(at)
  }
  return html.replace(/<html[^>]*>/i, function (tag) { return tag + REC_GATE })
}

function writeTempHtml(html) {
  const dir = path.join(os.tmpdir(), 'ztedit-rec')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'rec-' + Date.now() + '.html')
  fs.writeFileSync(file, html, 'utf-8')
  return file
}

function createRecWindow(w, h) {
  destroyRecWindow()
  // 多屏时挑一块放得下这个尺寸的显示器，否则窗口会被系统按当前屏裁剪
  let b = null
  try {
    const ds = screen.getAllDisplays()
    for (const d of ds) {
      if (d.bounds.width >= w && d.bounds.height >= h) { b = d.bounds; break }
    }
    if (!b && ds.length) b = ds[0].bounds
  } catch (e) {}
  recWin = new BrowserWindow({
    width: w,
    height: h,
    x: b ? b.x : undefined,
    y: b ? b.y : undefined,
    show: false, // 隐藏窗口；被 getDisplayMedia 捕获时 Chromium 仍会持续出帧
    skipTaskbar: true,
    focusable: false,
    backgroundColor: '#000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // 关键：隐藏窗口也要满帧渲染，否则录屏掉帧
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  // width/height 是外框尺寸，这里按内容区再校准一次，保证捕获到精确的 w×h
  recWin.setContentSize(w, h)
  return recWin
}

function destroyRecWindow() {
  if (recWin) {
    try {
      if (!recWin.isDestroyed()) recWin.destroy()
    } catch (e) {}
    recWin = null
  }
  if (recTmpFile) {
    try {
      fs.unlinkSync(recTmpFile)
    } catch (e) {}
    recTmpFile = null
  }
}

// 等窗口真正进入全屏并稳定下来。
// 为什么需要它：setFullScreen() 返回时窗口往往还在做样式重建与 DWM 重新合成，
// 这段余波会持续数百毫秒。要是刚调完就立刻 getDisplayMedia 建立捕获，
// 捕获源会在余波末尾失效（video track ended），录制只跑 100 多毫秒就收摊——
// H.264/AAC 编码器那点初始化时间根本不够，产物就只剩一个几 KB 的 moov 空壳
// （没有 vide trak、音频 sample_count=0，表面看像是"音轨静音"，实为秒停）。
// 所以这里等 enter-full-screen 事件落地，再多给一拍余量。
function waitFullscreenSettled(win, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const onEnter = () => settle()
    function settle() {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try { win.removeListener('enter-full-screen', onEnter) } catch (e) {}
      // 事件落地后 DWM 通常还有最后一波合成，再留 250ms
      setTimeout(resolve, 250)
    }
    timer = setTimeout(settle, timeoutMs || 2000)
    try {
      // 已经是全屏状态就不会再有 enter 事件，直接走余量等待
      if (win.isFullScreen()) {
        clearTimeout(timer)
        timer = setTimeout(settle, 100)
        return
      }
      win.on('enter-full-screen', onEnter)
    } catch (e) {
      settle()
    }
  })
}

function registerIpc() {
  ipcMain.handle('zt:open-html-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const picked = await pickHtmlAndFolder(win)
    if (!picked) return { canceled: true }
    const rootAbs = path.dirname(picked.htmlAbs)
    // 记下资源根目录：录屏页要靠它把相对资源改写成 file:// 绝对地址
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

  // 资源根目录（当前编辑 HTML 所在文件夹的绝对路径），供录屏页把相对资源改写成 file:// 绝对地址
  ipcMain.handle('zt:get-root', () => ({ root: recRoot || '' }))

  // 诊断：把离屏页里的真实音频状态抓出来。
  // 「有音轨却静音」时，一眼就能看出是 play 没被调用、被拒，还是播了但没数据。
  ipcMain.handle('zt:rec-state', async () => {
    if (!recWin || recWin.isDestroyed()) return { ok: false, error: '离屏窗口不存在（可能已关闭）' }
    try {
      const r = await recWin.webContents.executeJavaScript(`
        (function(){
          var a = document.getElementById('bgAudio') || document.querySelector('audio');
          return {
            diag: window.__ztDiag || null,
            audio: a ? {
              paused: a.paused, muted: a.muted, volume: a.volume,
              currentTime: Number(a.currentTime.toFixed(2)),
              readyState: a.readyState, networkState: a.networkState,
              duration: a.duration,
              src: String(a.currentSrc || a.src || '').split('/').pop(),
              err: a.error ? a.error.code : null
            } : null,
            slideCount: document.querySelectorAll('.slide').length,
            activeSlide: (function(){
              var all = document.querySelectorAll('.slide');
              for (var i=0;i<all.length;i++) if (all[i].classList.contains('active')) return i;
              return -1;
            })()
          };
        })()
      `)
      return { ok: true, ...r }
    } catch (e) {
      return { ok: false, error: String(e && e.message) }
    }
  })

  // 屏幕可用区域：离屏窗口不能超过它，否则 Chromium 拒绝渲染（页面加载直接 ERR_FAILED）。
  // UI 靠这个把录不到的档位置灰。
  // 直接全屏录屏：录制前主窗口全屏（画面=窗口内容，原生分辨率），结束后退出全屏。
  // 全屏时必须把菜单栏一并藏掉，否则 File/Edit 那条会被录进画面（Windows 实测踩坑）。
  ipcMain.handle('zt:set-fullscreen', async (event, on) => {
    try {
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.setFullScreen(!!on)
        mainWin.setMenuBarVisibility(!on)
        // 进全屏要等它真正落定再交回控制权：见 waitFullscreenSettled 的注释
        if (on) {
          mainWin.setAutoHideMenuBar(true)
          await waitFullscreenSettled(mainWin)
        }
      }
      return { ok: true, settled: !!on }
    } catch (e) {
      return { ok: false, error: String(e && e.message) }
    }
  })

  ipcMain.handle('zt:get-screen', () => {
    try {
      // 用 bounds 而不是 workAreaSize：录制窗口是隐藏的，不受任务栏遮挡约束，
      // 可用尺寸就是整块屏幕。用 workArea 会把 2K 档误判成不可用（任务栏吃掉的那几十像素）。
      let best = screen.getPrimaryDisplay()
      for (const d of screen.getAllDisplays()) {
        if (d.bounds.width * d.bounds.height > best.bounds.width * best.bounds.height) best = d
      }
      return {
        width: best.bounds.width,
        height: best.bounds.height,
        x: best.bounds.x,
        y: best.bounds.y,
        scaleFactor: best.scaleFactor || 1,
      }
    } catch (e) {
      return { width: 0, height: 0, x: 0, y: 0, scaleFactor: 1 }
    }
  })

  // 从草稿恢复时回填根目录：否则刷新页面后录屏拿不到 root，
  // 会静默退回"捕获编辑器窗口"的兜底方案（webm + 分辨率随窗口）
  ipcMain.handle('zt:set-root', (event, root) => {
    recRoot = typeof root === 'string' ? root : ''
    return { root: recRoot }
  })

  // 录屏准备：把自包含 HTML 写成临时文件，开一个定尺寸的隐藏窗口加载它，
  // 页面内的自动播放被 rec-gate 脚本拦住，等 zt:rec-start 才真正开播
  ipcMain.handle('zt:rec-prepare', async (event, payload) => {
    const { html, width, height } = payload || {}
    if (!html) return { ok: false, error: '无 HTML 内容' }
    try {
      const w = Number(width) || 1920
      const h = Number(height) || 1080
      // 顺序不能反：createRecWindow() 内部会先 destroyRecWindow() 清掉上一轮残留，
      // 而它会一并清空 recTmpFile 并删掉那个临时文件。
      // 若先写文件再建窗口，刚写的文件会被自己删掉、recTmpFile 变成 null，
      // loadFile(null) 就会抛 "Must pass filePath as a string"。
      const win = createRecWindow(w, h)
      recTmpFile = writeTempHtml(withRecGate(html))
      await win.loadFile(recTmpFile)
      // 等首帧渲染完成，避免录到白屏
      await new Promise((r) => setTimeout(r, 800))
      return { ok: true, width: w, height: h }
    } catch (e) {
      return { ok: false, error: String(e && e.message) }
    }
  })

  // 放行离屏页的自动播放，与编辑器内的播放同时起步
  ipcMain.handle('zt:rec-start', () => {
    if (recWin && !recWin.isDestroyed()) recWin.webContents.send('zt:rec-start')
    return { ok: true }
  })

  ipcMain.handle('zt:rec-close', () => {
    destroyRecWindow()
    return { ok: true }
  })

  // 录屏：保存视频文件（渲染进程录好 blob 后传 ArrayBuffer 过来落盘）
  // 带 dir（HTML 所在目录）时免弹窗直接写入该目录；否则弹保存框让用户挑位置
  ipcMain.handle('zt:save-recording', async (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const { data, ext, suggestedName, dir } = payload || {}
    if (!data) return { canceled: true, error: '无数据' }
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    if (dir && typeof dir === 'string' && path.isAbsolute(dir) && fs.existsSync(dir)) {
      try {
        const autoPath = path.join(dir, suggestedName || `录屏-${stamp}.${ext || 'webm'}`)
        fs.writeFileSync(autoPath, Buffer.from(data))
        return { canceled: false, filePath: autoPath, auto: true }
      } catch (e) {
        // 目录写入失败（只读/被占用）→ 退回保存框，别让成片丢掉
        console.warn('[rec] 自动落盘失败，退回保存框：' + String(e && e.message))
      }
    }
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

// 离屏录制窗口的播放由 IPC 触发，不属于用户手势，
// 不放开自动播放策略的话 Chromium 会拦掉 audio.play()，时间轴根本不走、只能录到静止首屏
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

app.whenReady().then(() => {
  registerIpc()
  // 录屏：getDisplayMedia 直接捕获指定窗口的页面内容（不含标题栏，无需用户选窗口）
  // 优先捕获离屏录制窗口（定尺寸 1080p/2K/4K），没有则退回主窗口（浏览器模式兜底）
  // 注意：Electron 29+ 要求 video 是 WebFrameMain 或 DesktopCapturerSource，不能传 webContents
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const target = recWin && !recWin.isDestroyed() ? recWin : mainWin
    if (target && !target.isDestroyed() && target.webContents.mainFrame) {
      const frame = target.webContents.mainFrame
      // audio 与 video 指向同一个窗口：画面与声音取自同一份播放实例，音画零偏移。
      // 若画面取离屏页、声音取编辑器页（两个独立实例），实测会有约 40ms 的固有错位。
      callback({ video: frame, audio: frame })
    } else {
      callback({})
    }
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
  destroyRecWindow() // 兜底：清掉离屏窗口与临时文件
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  destroyRecWindow()
})
