// 文件夹选择 + 文件映射 + 相对路径解析
// 用户通过 webkitdirectory 选择包含 HTML 及其资源（图片/视频等）的整个文件夹

// 原生文件浏览框，文件类型自动筛选为 HTML
// 选择单个 HTML 文件后直接返回该 File（含它的文件名）
export function pickHtmlFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.html,.htm,text/html'
    input.onchange = () => {
      const f = input.files && input.files[0]
      if (!f) {
        reject(new Error('未选择任何文件'))
        return
      }
      resolve(f)
    }
    input.oncancel = () => reject(new Error('已取消'))
    input.click()
  })
}

// 是否在 Electron 桌面环境（通过 preload 暴露的 ztPick 判断）
// 在 Electron 下才能“选单个 HTML 但加载其所在文件夹的完整资源”
export function isElectron() {
  return !!(typeof window !== 'undefined' && window.ztPick && window.ztPick.openHtmlFolder)
}

// base64 -> File 对象（指定文件名与相对路径）
function fileFromBase64(base64, name, type) {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], name, { type: type || '' })
}

// Electron 后端方案：挂出原生文件框（筛选 html），选中单个 HTML 后读取其所在文件夹的
// 全部资源，重建为 key=根目录名/相对路径 的 File 映射。
// 返回 { mainKey, map }，其中 map = Map<relKey, File>
export async function pickHtmlFolderBackend() {
  if (!isElectron()) {
    throw new Error('当前不在 Electron 环境，无法读取文件夹')
  }
  const res = await window.ztPick.openHtmlFolder()
  if (!res || res.canceled) throw new Error('已取消')
  const map = new Map()
  for (const f of res.files || []) {
    const r = await window.ztPick.readFileB64(f.absPath)
    if (!r || !r.ok) continue // 单个文件读取失败则跳过
    const key = res.rootName + '/' + f.relPath
    const file = fileFromBase64(r.data, f.name, mimeFromExt(f.name))
    // webkitRelativePath 不可写，这里用它覆盖冲突；真正取 key 用 map key
    try {
      Object.defineProperty(file, 'webkitRelativePath', { value: key })
    } catch (e) {}
    map.set(key, file)
  }
  const mainKey = res.rootName + '/' + res.mainHtmlName
  if (!map.has(mainKey)) {
    throw new Error('在选定 HTML 所在文件夹中未能找到主文件')
  }
  return { mainKey, map }
}

function mimeFromExt(name) {
  const ext = (name.split('.').pop() || '').toLowerCase()
  const m = {
    html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript',
    mjs: 'text/javascript', json: 'application/json', svg: 'image/svg+xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', ico: 'image/x-icon',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
    m4a: 'audio/mp4', aac: 'audio/aac',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
  }
  return m[ext] || ''
}

// 建立 path -> File 映射，key 为 webkitRelativePath（含根目录名）
export function buildFileMap(files) {
  const map = new Map()
  for (const f of files) {
    const key = f.webkitRelativePath || f.name
    map.set(key, f)
  }
  return map
}


// 主 HTML 所在目录（去掉文件名，保留根目录名）
export function dirOf(relPath) {
  const i = relPath.lastIndexOf('/')
  return i >= 0 ? relPath.slice(0, i) : ''
}

// 解析相对路径，正确处理 ../ 与 ./
export function resolvePath(baseDir, rel) {
  const parts = baseDir ? baseDir.split('/') : []
  for (const p of rel.split('/')) {
    if (p === '' || p === '.') continue
    if (p === '..') parts.pop()
    else parts.push(p)
  }
  return parts.join('/')
}

// 从某个 HTML 文件所在目录，计算到目标资源文件的相对路径（供导出/素材插入使用）
export function toRelativePath(baseDir, filePath) {
  const base = (baseDir || '').split('/').filter(Boolean)
  const file = filePath.split('/').filter(Boolean)
  let common = 0
  while (common < base.length && common < file.length && base[common] === file[common]) {
    common++
  }
  const upCount = base.length - common
  const down = file.slice(common).join('/')
  const rel = (upCount > 0 ? '../'.repeat(upCount) : '') + down
  return rel || filePath
}
