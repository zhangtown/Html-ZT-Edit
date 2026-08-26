// HTML-ZtEdit 预加载脚本：把「选择 HTML → 加载其所在文件夹的全部资源」的能力
// 安全地暴露给渲染进程。本质是 fs/IPC 的一层白名单桥接。

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ztPick', {
  // 弹出原生文件框（筛选 .html/.htm），返回所选 HTML 所在文件夹的文件清单（元数据，不含内容）
  openHtmlFolder: () => ipcRenderer.invoke('zt:open-html-folder'),
  // 按绝对路径读取单个文件，以 base64 字符串返回
  readFileB64: (absPath) => ipcRenderer.invoke('zt:read-file-b64', absPath),
})