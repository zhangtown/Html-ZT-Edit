// HTML 预处理：剥离自动播放脚本、重写资源为 blob URL
// 以及导出时恢复资源引用 + 还原脚本

import { resolvePath } from './loadFolder.js'

const ASSET_TAGS = [
  ['img', 'src'],
  ['video', 'src'],
  ['source', 'src'],
  ['audio', 'src'],
  ['link', 'href'],
  ['iframe', 'src'],
]

function isExternal(val) {
  return /^(https?:|data:|blob:|#|mailto:)/i.test(val || '')
}

// 剥离 <script>（编辑模式不需要自动播放，避免干扰）
// 返回去掉脚本后的 html 与脚本片段数组（导出时还原）
export function stripScripts(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const scripts = []
  doc.querySelectorAll('script').forEach((s) => {
    if (s.src) {
      scripts.push(`<script src="${s.getAttribute('src')}"></script>`)
    } else if (s.textContent && s.textContent.trim()) {
      scripts.push(`<script>${s.textContent}</script>`)
    }
    s.remove()
  })
  return { html: doc.documentElement.outerHTML, scripts }
}

// 把相对资源引用重写为 blob URL，并建立 blob -> 原始引用 的反查表（导出恢复用）
export function rewriteAssets(html, baseDir, fileMap, relMap) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const [tag, attr] of ASSET_TAGS) {
    doc.querySelectorAll(tag).forEach((el) => {
      const val = el.getAttribute(attr)
      if (!val || isExternal(val)) return
      const resolved = resolvePath(baseDir, val)
      const file = fileMap.get(resolved)
      if (file) {
        const url = URL.createObjectURL(file)
        relMap.set(url, val) // blob:url -> 原始引用字符串
        el.setAttribute(attr, url)
      }
    })
  }
  return doc.documentElement.outerHTML
}

// 清理编辑器注入物：删除编辑器样式与运行时脚本标签，并剥离 zt-grid / zt-selected 类，
// 用于草稿保存（保留用户编辑痕迹，去除编辑器自身状态）
export function stripEditorParts(html) {
  return html
    .replace(/<style id="zt-editor-style">[\s\S]*?<\/style>/g, '')
    .replace(/<script id="zt-editor-runtime">[\s\S]*?<\/script>/g, '')
    .replace(/\s+class="([^"]*)"/g, (m, cls) => {
      const cleaned = cls
        .replace(/\s*\b(zt-grid|zt-selected)\b\s*/g, ' ')
        .trim()
      return cleaned ? ` class="${cleaned}"` : ''
    })
}

// 导出：把 iframe 回传的 html 中的 blob URL 恢复为原始相对引用，
// 并把脚本片段还原回 body，最后包裹成完整文档
export function restoreAndWrap(iframeHtml, relMap, scripts) {
  let html = iframeHtml
  for (const [blob, rel] of relMap.entries()) {
    html = html.split(blob).join(rel)
  }
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const body = doc.body || doc.documentElement
  for (const s of scripts) {
    body.insertAdjacentHTML('beforeend', s)
  }
  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML
}
