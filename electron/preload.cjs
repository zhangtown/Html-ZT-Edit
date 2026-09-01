// HTML-ZtEdit 预加载脚本：把「选择 HTML → 加载其所在文件夹的全部资源」与
// 「OBS 系统级录制」的能力安全地暴露给渲染进程。本质是 fs/IPC 的一层白名单桥接。

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ztPick', {
  // 弹出原生文件框（筛选 .html/.htm），返回所选 HTML 所在文件夹的文件清单（元数据，不含内容）
  openHtmlFolder: () => ipcRenderer.invoke('zt:open-html-folder'),
  // 按绝对路径读取单个文件，以 base64 字符串返回
  readFileB64: (absPath) => ipcRenderer.invoke('zt:read-file-b64', absPath),
})

// 资源根目录（当前编辑 HTML 所在文件夹的绝对路径）：OBS 成片落点，主进程才知道
contextBridge.exposeInMainWorld('ztRoot', {
  get: () => ipcRenderer.invoke('zt:get-root'),
  set: (root) => ipcRenderer.invoke('zt:set-root', root),
})

// OBS 系统级录制（全自动一键）：连接 OBS → 开始/停止录制 → 查状态。
// 渲染端 window.ztRecSession.startOBS/stopOBS/obsStatus 对应主进程 zt:obs-*。
contextBridge.exposeInMainWorld('ztRecSession', {
  startOBS: (opts) => ipcRenderer.invoke('zt:obs-start', opts),
  stopOBS: () => ipcRenderer.invoke('zt:obs-stop'),
  obsStatus: () => ipcRenderer.invoke('zt:obs-status'),
  // 主进程在捕获用的浏览器窗口被关掉时推送：渲染端据此自动退出「录制中」态
  onBrowserClosed: (cb) => ipcRenderer.on('zt:obs-browser-closed', (_e, r) => cb(r || {})),
})
