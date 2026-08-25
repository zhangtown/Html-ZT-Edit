/**
 * 将样例 HTML 的数组字幕（const subtitles = [...]）转换为 DOM 元素格式
 * 每个字幕变成 <div data-zt-role="subtitle" data-zt-subtitle-start="..." data-zt-subtitle-end="...">
 * 插入到对应 slide 中，时间转为相对当前 slide 起始时间的相对值
 */

const fs = require('fs')
const path = require('path')

const filePath = path.resolve(__dirname, '../样例HTML工程/样例.html')
let html = fs.readFileSync(filePath, 'utf-8')

// ---- 1. 提取 subtitles 和 slideTimings 数组的字符串 ----
const subMatch = html.match(/const\s+subtitles\s*=\s*([\s\S]*?)\s*;\s*(?=const|let|var|function|$)/)
const tmMatch = html.match(/const\s+slideTimings\s*=\s*([\s\S]*?)\s*;\s*(?=const|let|var|function|$)/)

if (!subMatch || !tmMatch) {
  console.error('未找到 subtitles 或 slideTimings 数组')
  process.exit(1)
}

const subStr = subMatch[1].trim()
const tmStr = tmMatch[1].trim()

// 解析数组（用 Function 而非 eval，因为 slideTimings 的 key 未加引号，不是合法 JSON）
let subtitles, slideTimings
try {
  subtitles = new Function('return ' + subStr)()
  slideTimings = new Function('return ' + tmStr)()
} catch (e) {
  console.error('解析数组失败:', e.message)
  process.exit(1)
}

console.log(`找到 ${subtitles.length} 条字幕，${slideTimings.length} 个 slide 时间`)

// ---- 2. 为每个 slide 生成字幕 DOM 容器 ----
// 倒序遍历，以免插入后影响后续位置
for (let si = slideTimings.length - 1; si >= 0; si--) {
  const st = slideTimings[si]
  const slideSubs = subtitles.filter(s => s.startSec >= st.start && s.startSec < st.end)
  if (slideSubs.length === 0) continue

  // 生成字幕容器 HTML
  const subItems = slideSubs.map(s => {
    const relStart = (s.startSec - st.start).toFixed(3)
    const relEnd = (s.endSec - st.start).toFixed(3)
    // 转义文本中的 HTML 特殊字符
    const text = s.text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
    return `    <div data-zt-role="subtitle" data-zt-subtitle-start="${relStart}" data-zt-subtitle-end="${relEnd}">${text}</div>`
  }).join('\n')

  const container = `\n  <!-- 字幕（编辑器绑定用） -->\n  <div class="slide-subtitles" style="display:none">\n${subItems}\n  </div>\n`

  // 找到该 slide 的 id="sX" 位置
  const slideId = `id="s${si}"`
  const idIdx = html.indexOf(slideId)
  if (idIdx < 0) {
    console.warn(`未找到 slide s${si}，跳过`)
    continue
  }

  // 从 id 往前找到该 slide 的 <div 起始标签
  const divStart = html.lastIndexOf('<div', idIdx)
  if (divStart < 0) {
    console.warn(`未找到 slide s${si} 的 <div 标签，跳过`)
    continue
  }

  // 找到该起始标签的结束 >（考虑属性中可能有的 >）
  // 简单方法：从 divStart 开始找到第一个 >，且不在引号内
  let tagEnd = -1
  let inQuote = false
  let quoteChar = ''
  for (let i = divStart; i < html.length; i++) {
    const ch = html[i]
    if (inQuote) {
      if (ch === quoteChar) inQuote = false
    } else if (ch === '"' || ch === "'") {
      inQuote = true
      quoteChar = ch
    } else if (ch === '>') {
      tagEnd = i
      break
    }
  }
  if (tagEnd < 0) {
    console.warn(`未找到 slide s${si} 的 >，跳过`)
    continue
  }

  // 从 tagEnd 之后开始，用括号匹配找到对应的 </div>
  let depth = 0
  let insertIdx = -1
  let i = tagEnd + 1
  while (i < html.length) {
    // 检查 <div 开头（可能有属性，也可能直接 >）
    if (html[i] === '<' && html.slice(i, i + 5) === '<div ') {
      depth++
      i += 5
      continue
    }
    // 检查 <div>（无属性）
    if (html[i] === '<' && html.slice(i, i + 5) === '<div>') {
      depth++
      i += 5
      continue
    }
    // 检查 </div>
    if (html[i] === '<' && html.slice(i, i + 6) === '</div>') {
      if (depth === 0) {
        insertIdx = i
        break
      }
      depth--
      i += 6
      continue
    }
    i++
  }

  if (insertIdx < 0) {
    console.warn(`未找到 slide s${si} 的匹配 </div>，跳过`)
    continue
  }

  // 在 </div> 之前插入字幕容器
  html = html.slice(0, insertIdx) + container + html.slice(insertIdx)
  console.log(`  slide s${si}: 插入 ${slideSubs.length} 条字幕`)
}

// ---- 3. 写回文件 ----
fs.writeFileSync(filePath, html, 'utf-8')
console.log('\n转换完成！')