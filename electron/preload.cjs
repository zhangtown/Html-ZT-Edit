// HTML-ZtEdit 预加载脚本：把「选择 HTML → 加载其所在文件夹的全部资源」的能力
// 安全地暴露给渲染进程。本质是 fs/IPC 的一层白名单桥接。

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ztPick', {
  // 弹出原生文件框（筛选 .html/.htm），返回所选 HTML 所在文件夹的文件清单（元数据，不含内容）
  openHtmlFolder: () => ipcRenderer.invoke('zt:open-html-folder'),
  // 按绝对路径读取单个文件，以 base64 字符串返回
  readFileB64: (absPath) => ipcRenderer.invoke('zt:read-file-b64', absPath),
})

contextBridge.exposeInMainWorld('ztRec', {
  // 保存录屏视频：data 为 ArrayBuffer，ext 不带点（如 'webm'/'mp4'）；
  // 传 dir（HTML 所在目录绝对路径）时免弹窗直接落盘
  saveRecording: (data, ext, suggestedName, dir) =>
    ipcRenderer.invoke('zt:save-recording', { data, ext, suggestedName, dir }),
})

// 录制会话控制（离屏录制窗口 + 主窗口共用）
contextBridge.exposeInMainWorld('ztRecSession', {
  // 把自包含 HTML 交给主进程：写临时文件 + 开定尺寸隐藏窗口加载，页面播放被拦住待发令
  prepare: (html, width, height) =>
    ipcRenderer.invoke('zt:rec-prepare', { html, width, height }),
  // 放行离屏页的自动播放，与编辑器内播放同时起步
  start: () => ipcRenderer.invoke('zt:rec-start'),
  // 结束录制：销毁离屏窗口、删除临时文件
  close: () => ipcRenderer.invoke('zt:rec-close'),
  // 当前编辑 HTML 所在文件夹的绝对路径（桌面端才有，浏览器模式返回空串）
  getRoot: () => ipcRenderer.invoke('zt:get-root'),
  // 从草稿恢复后回填根目录，保证刷新页面仍能走离屏录制
  setRoot: (root) => ipcRenderer.invoke('zt:set-root', root),
  // 屏幕可用区域（CSS 像素）：离屏窗口不能比它大，否则页面根本渲染不出来
  getScreen: () => ipcRenderer.invoke('zt:get-screen'),
  // 诊断用：取离屏页里 audio 的真实状态（排查"有音轨却静音"）
  getState: () => ipcRenderer.invoke('zt:rec-state'),
  // 直接全屏录屏：主窗口进入/退出全屏
  setFullscreen: (on) => ipcRenderer.invoke('zt:set-fullscreen', on),
  // OBS 录制后端（方案 A）触发点：连接 OBS 并开始/停止录制，或查状态
  startOBS: (opts) => ipcRenderer.invoke('zt:obs-start', opts),
  stopOBS: () => ipcRenderer.invoke('zt:obs-stop'),
  obsStatus: () => ipcRenderer.invoke('zt:obs-status'),
  // 读取 OBS 真实场景列表（UI 下拉选择，避免手打场景名 / 场景不在当前集合）
  obsScenes: () => ipcRenderer.invoke('zt:obs-scenes'),
  // 读取 OBS 可捕获窗口列表（选 ztEdit 主窗口 → 自动建窗口捕获源，杜绝黑屏）
  obsWindows: () => ipcRenderer.invoke('zt:obs-windows'),
})

// 离屏录制窗口专用：接收主进程转发的「开始播放」信号
contextBridge.exposeInMainWorld('ztRecCtl', {
  onStart: (cb) => ipcRenderer.on('zt:rec-start', () => cb()),
})