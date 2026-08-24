// 文件夹选择 + 文件映射 + 相对路径解析
// 用户通过 webkitdirectory 选择包含 HTML 及其资源（图片/视频等）的整个文件夹

export function pickFolder() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.webkitdirectory = true
    input.multiple = true
    input.onchange = () => {
      const files = Array.from(input.files || [])
      if (files.length === 0) {
        reject(new Error('未选择任何文件'))
        return
      }
      resolve(files)
    }
    input.oncancel = () => reject(new Error('已取消'))
    input.click()
  })
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

// 列出目录下所有 HTML 文件（返回相对根目录的路径）
export function listHtmlFiles(files) {
  return files
    .filter(
      (f) =>
        /\.html?$/i.test(f.name) &&
        !/(^|\/)(node_modules|\.git)\//.test(f.webkitRelativePath || f.name)
    )
    .map((f) => f.webkitRelativePath || f.name)
    .sort()
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
