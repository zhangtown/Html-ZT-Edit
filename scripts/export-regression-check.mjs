// 导出产物回归测试  node scripts/export-regression-check.mjs
//
// 覆盖对象：src/htmlProcess.js 的导出/清理链路（stripEditorParts / stripEditorFromDoc /
// restoreAndWrap / generatePlaybackScript / FOCUS_CSS），以及 src/animEffects.js 的动画引擎。
//
// 回归点（针对已修复/防止回退的 bug）：
//   1. 编辑器注入物剥离：产物不得残留 zt-editor-style / zt-editor-runtime / zt-editor-fonts /
//      zt-anim-sweep 这 4 个注入标签（zt-anim-sweep 里的 .zt-focus-active 带红框 outline，
//      漏剥会被烤进产物 → 焦点激活时卡片多一圈红框，已修）。
//   2. 编辑态类剥离：产物 class 里不得残留 zt-grid/zt-selected/zt-focus-active/zt-hl-sweep/
//      zt-hl-active/zt-bound-mark/zt-bound-highlight/zt-binding-target/dim-others。
//   3. 视觉正确：产物 FOCUS_CSS 组外兜底 .zt-focus-active 不得含 box-shadow（多光晕，已修）；
//      组内 .focus-group.dim-others .focus-item.zt-focus-active 必须保留 box-shadow（光晕是本意）。
//   4. 红框绝不出现：产物不得含 "outline:2px solid rgba(196,30,36" 之类编辑态红框。
//   5. 契约数据保留：data-zt-*（id/anim-effect/bound-to/role/subtitle-start/end）在产物里与源一致，
//      导出不得改坏数据格式（契约版本 WORKFLOW.md「二」）。
//   6. 播放脚本：generatePlaybackScript 输出语法合法，含 slideTimings/subtitles/focus/highlight-sweep 分支。
//   7. 回开场页：restoreAndWrap 产物 .slide 只有首屏 active。
//   8. 组信息不丢：restoreAndWrap 产物保留 focus-group 类。
//
// 依赖：jsdom（devDependency，仅测试用）。真实源 HTML 在 样例HTML工程/模板-唐朝不存在风格-v5.5.html。

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { JSDOM } from 'jsdom'
import {
  stripEditorParts,
  restoreAndWrap,
  stripScripts,
} from '../src/htmlProcess.js'
import { animEngineSource } from '../src/animEffects.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
let passed = 0

// ---- jsdom 补全局浏览器 API（restoreAndWrap/stripScripts 内部用 new DOMParser()）----
const jsdomWindow = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>').window
global.DOMParser = jsdomWindow.DOMParser
if (typeof global.URL.createObjectURL !== 'function') {
  global.URL.createObjectURL = () => 'blob:test-fake-url'
}

function check(label, cond, extra) {
  if (cond) {
    passed++
    console.log('  PASS  ' + label)
  } else {
    failed++
    console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : ''))
  }
}

function section(title) {
  console.log('\n[' + title + ']')
}

// ---- 夹具 A：构造一个含全部编辑器注入物 + 红框 + 编辑态类的「脏」HTML ----
// 模拟编辑器 iframe 序列化出来的样子（serialize() 原样回传带编辑器样式/脚本/DOM 状态）。
function dirtyFixture() {
  return `<!DOCTYPE html>
<html><head>
<style id="zt-editor-style">*{animation:none!important;transition:none!important}</style>
<style id="zt-editor-fonts">[data-zt-ff]{font-family:var(--zt-ff)!important}</style>
<style id="zt-anim-sweep">.zt-focus-active{outline:2px solid rgba(196,30,36,.5);outline-offset:2px;box-shadow:0 0 40px rgba(196,30,36,.4)}</style>
</head><body>
<div class="slide active zt-selected" data-zt-id="s1">
  <div class="tl-row focus-group" id="fg-timeline">
    <div class="tl-node focus-item zt-focus-active zt-bound-highlight" data-zt-id="el-1-1" data-zt-anim-effect="focus-zoom" data-zt-anim-duration="1.2" data-zt-anim-delay="0.2" data-zt-anim-return="0.6" data-zt-anim-easing="ease" data-zt-bound-to="[data-zt-id='sub-1']">卡片一</div>
  </div>
  <div class="lr-row"><div class="lr-left"><div class="focus-item dim-others zt-grid" data-zt-id="el-1-0" data-zt-anim-effect="focus-zoom">印章</div></div></div>
  <div class="slide-subtitles"><div class="subtitle zt-hl-sweep zt-hl-active zt-bound-mark zt-binding-target" data-zt-role="subtitle" data-zt-subtitle-start="1.2" data-zt-subtitle-end="4.5" data-zt-id="sub-1" data-zt-bound-to="[data-zt-id='el-1-1']">第一条字幕</div></div>
</div>
<div id="zt-resize-overlay" style="position:fixed;top:0;left:0;width:100%;height:100%;"><div data-dir="nw" style="width:12px;height:12px;background:#C41E24;"></div></div>
<div id="zt-guide-overlay" style="position:fixed;"></div>
<div id="zt-box-select" style="border:1px solid #2563eb;"></div>
<script id="zt-editor-runtime">window.__ztEditorRuntime = { version: 1 }</script>
</body></html>`
}

// ---- 工具：从源码抠出非导出函数真实实现（括号配对，跳过字符串）----
function extractFn(fileSrc, fnName) {
  const sig = new RegExp('function\\s+' + fnName + '\\s*\\([^)]*\\)\\s*\\{')
  const m = sig.exec(fileSrc)
  if (!m) throw new Error('未找到函数 ' + fnName)
  let depth = 0, quote = null, end = -1
  for (let i = m.index + m[0].length - 1; i < fileSrc.length; i++) {
    const c = fileSrc[i]
    if (quote) { if (c === '\\') { i++; continue } if (c === quote) quote = null; continue }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  if (end < 0) throw new Error('函数 ' + fnName + ' 括号未配对')
  return fileSrc.slice(m.index, end + 1)
}

// ---- 组1：stripEditorParts 字符串路径 ----
section('1. stripEditorParts 注入物剥离（字符串路径）')
{
  const out = stripEditorParts(dirtyFixture())
  check('不含 <style id="zt-editor-style">', out.indexOf('zt-editor-style') < 0)
  check('不含 <style id="zt-editor-fonts">', out.indexOf('zt-editor-fonts') < 0)
  check('不含 <style id="zt-anim-sweep">', out.indexOf('zt-anim-sweep') < 0)
  check('不含 <script id="zt-editor-runtime">', out.indexOf('zt-editor-runtime') < 0)
  check('不含红框 outline:2px solid rgba(196,30,36', out.indexOf('outline:2px solid rgba(196,30,36') < 0)
  check('class 已剥离 zt-selected', !/\bzt-selected\b/.test(out))
  check('class 已剥离 zt-focus-active', !/\bzt-focus-active\b/.test(out))
  check('class 已剥离 zt-bound-highlight', !/\bzt-bound-highlight\b/.test(out))
  check('class 已剥离 dim-others', !/\bdim-others\b/.test(out))
  check('class 已剥离 zt-grid', !/\bzt-grid\b/.test(out))
  check('class 已剥离 zt-hl-sweep/zt-hl-active', !/\bzt-hl-sweep\b/.test(out) && !/\bzt-hl-active\b/.test(out))
  check('class 已剥离 zt-bound-mark/zt-binding-target', !/\bzt-bound-mark\b/.test(out) && !/\bzt-binding-target\b/.test(out))
  check('契约属性保留：data-zt-id', out.indexOf('data-zt-id="el-1-1"') >= 0)
  check('契约属性保留：data-zt-anim-effect', out.indexOf('data-zt-anim-effect="focus-zoom"') >= 0)
  check('契约属性保留：data-zt-bound-to', out.indexOf('data-zt-bound-to') >= 0)
  check('契约属性保留：data-zt-role/subtitle-start/end', out.indexOf('data-zt-role="subtitle"') >= 0 && out.indexOf('data-zt-subtitle-start') >= 0 && out.indexOf('data-zt-subtitle-end') >= 0)
  check('focus-group 组信息保留', out.indexOf('focus-group') >= 0)
  // 编辑器覆盖层（缩放手柄/参考线/框选矩形）必须被剥掉——否则红方块会被烤进草稿与录制产物
  check('覆盖层已剥离 zt-resize-overlay/zt-guide-overlay/zt-box-select', !/zt-resize-overlay|zt-guide-overlay|zt-box-select/.test(out))
  check('覆盖层内部红方块 data-dir 已剥离', out.indexOf('data-dir') < 0)
}

// ---- 组2：stripEditorFromDoc DOM 路径（编辑保存走这条）----
section('2. stripEditorFromDoc 注入物剥离（DOM 路径）')
{
  const hp = fs.readFileSync(path.join(root, 'src/htmlProcess.js'), 'utf8')
  const stripEditorFromDoc = new Function(extractFn(hp, 'stripEditorFromDoc') + '\nreturn stripEditorFromDoc;')()
  const doc = new DOMParser().parseFromString(dirtyFixture(), 'text/html')
  stripEditorFromDoc(doc)
  const out = doc.documentElement.outerHTML
  check('不含 zt-editor-style/zt-editor-fonts/zt-anim-sweep/zt-editor-runtime',
    ['zt-editor-style', 'zt-editor-fonts', 'zt-anim-sweep', 'zt-editor-runtime'].every((k) => out.indexOf(k) < 0))
  check('class 已剥离编辑态类', !/zt-selected|zt-focus-active|zt-bound-highlight|dim-others|zt-grid|zt-hl-sweep|zt-hl-active|zt-bound-mark|zt-binding-target/.test(out))
  check('契约属性保留', out.indexOf('data-zt-id="el-1-1"') >= 0 && out.indexOf('data-zt-anim-effect="focus-zoom"') >= 0 && out.indexOf('data-zt-bound-to') >= 0)
  check('focus-group 组信息保留', out.indexOf('focus-group') >= 0)
  // DOM 路径同样必须把覆盖层剥掉（getElementById 只删第一个，需按选择器全删）
  check('覆盖层已剥离（DOM 路径）', !/zt-resize-overlay|zt-guide-overlay|zt-box-select|data-dir/.test(out))
  // 回开场页：.slide 只有首屏 active
  const slides = doc.querySelectorAll('.slide')
  let activeCount = 0
  slides.forEach((s) => { if (s.classList.contains('active')) activeCount++ })
  check('只有首屏 .slide active（回开场页）', activeCount === 1 && slides[0].classList.contains('active'), 'active=' + activeCount)
}

// ---- 组3：FOCUS_CSS 视觉正确（防多光晕/红框回退）----
section('3. FOCUS_CSS 视觉正确性')
{
  const hp = fs.readFileSync(path.join(root, 'src/htmlProcess.js'), 'utf8')
  const m = hp.match(/const FOCUS_CSS = ([\s\S]*?)\n(?=\/\/ 在产物侧剥离编辑器注入物)/)
  check('FOCUS_CSS 常量存在', !!m)
  if (m) {
    // eval 出真实字符串
    const focusCss = eval(m[1])
    const groupRule = focusCss.match(/\.focus-group\.dim-others \.focus-item\.zt-focus-active\{[^}]*\}/)
    const outsideRule = focusCss.match(/\n\.zt-focus-active\{[^}]*\}/)
    // 组内规则必须保留光晕（淡红 box-shadow 是本意）
    check('组内 .focus-group.dim-others .focus-item.zt-focus-active 保留 box-shadow 光晕',
      !!groupRule && groupRule[0].indexOf('box-shadow:0 0 50px rgba(196,30,36,.35)') >= 0)
    // 组外兜底 .zt-focus-active 不得含 box-shadow（多光晕已修）
    check('组外兜底 .zt-focus-active 不含 box-shadow（防多光晕）',
      !!outsideRule && outsideRule[0].indexOf('box-shadow') < 0,
      outsideRule ? outsideRule[0].slice(0, 80) : '规则缺失')
    // 组外兜底仍保留放大（聚焦效果不退化为无）
    check('组外兜底 .zt-focus-active 仍保留 transform:scale 放大',
      !!outsideRule && /transform:\s*scale\(/.test(outsideRule[0]))
    // 红框 outline 绝不能出现在 FOCUS_CSS 里
    check('FOCUS_CSS 不含 outline 红框', focusCss.indexOf('outline') < 0)
  }
}

// ---- 组4：契约数据保留（restoreAndWrap 全流程，对每个夹具跑）----
// 夹具：真实源 v5.5（验收基准）+ 测试工程 speech-visual-test.html（回归样例，speech 技能产物）
function verifyFixture(label, srcPath) {
  const srcHtml = fs.readFileSync(srcPath, 'utf8')
  const { scripts, html: strippedHtml } = stripScripts(srcHtml)
  const relMap = new Map() // 无资源改写，直接空 map
  const out = restoreAndWrap(strippedHtml, relMap, scripts)

  // 统计源 vs 产物的契约数据量，必须一致（导出不得改坏数据）。
  // 注意：播放脚本里会注入 "data-zt-anim-effect=\"highlight-sweep\"" 之类的字符串常量（给
  // highlight-sweep 元素挂类的选择器），统计前必须剔除 <script> 块，否则会把脚本字符串误算成属性。
  const count = (html, re) => ((html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').match(re)) || []).length
  const checks = [
    ['data-zt-id', /data-zt-id=/g],
    ['data-zt-anim-effect', /data-zt-anim-effect=/g],
    ['data-zt-bound-to', /data-zt-bound-to=/g],
    ['data-zt-role', /data-zt-role=/g],
    ['data-zt-subtitle-start', /data-zt-subtitle-start=/g],
    ['data-zt-subtitle-end', /data-zt-subtitle-end=/g],
  ]
  let ok = true
  for (const [name, re] of checks) {
    const a = count(srcHtml, re)
    const b = count(out, re)
    const pass = a === b
    ok = ok && pass
    check(`[${label}] 契约属性 ${name} 数量不变（源 ${a} / 产物 ${b}）`, pass, `差 ${b - a}`)
  }
  check(`[${label}] 产物不含编辑器注入物`, ['zt-editor-style', 'zt-editor-fonts', 'zt-anim-sweep', 'zt-editor-runtime'].every((k) => out.indexOf(k) < 0))
  check(`[${label}] 产物不含红框 outline`, out.indexOf('outline:2px solid rgba(196,30,36') < 0)
  check(`[${label}] 产物保留 focus-group`, /class="[^"]*focus-group/.test(out))
  // 回开场页：只有首屏 active
  const doc2 = new DOMParser().parseFromString(out, 'text/html')
  const slides = doc2.querySelectorAll('.slide')
  let activeCount = 0
  slides.forEach((s) => { if (s.classList.contains('active')) activeCount++ })
  const activeOk = activeCount === 1 && slides[0].classList.contains('active')
  ok = ok && activeOk
  check(`[${label}] 产物只有首屏 .slide active`, activeOk, 'active=' + activeCount)
  // 产物包含注入的播放脚本 + FOCUS_CSS
  check(`[${label}] 产物含重新生成的播放脚本`, out.indexOf('startPlayback') >= 0)
  check(`[${label}] 产物含 FOCUS_CSS 注入`, out.indexOf('.focus-group .focus-item{transition') >= 0)
  // 产物是完整文档
  check(`[${label}] 产物以 <!DOCTYPE html> 开头`, out.startsWith('<!DOCTYPE html>'))
  return ok
}

const fixtures = [
  ['v5.5 真实源', path.join(root, '样例HTML工程/模板-唐朝不存在风格-v5.5.html')],
  ['speech-visual-test', path.join(root, '测试工程/speech-visual-test.html')],
]
for (const [label, fp] of fixtures) {
  section('4.' + (fixtures.indexOf([label, fp]) + 1) + ' restoreAndWrap 全流程（' + label + '）')
  check(`[${label}] 夹具存在`, fs.existsSync(fp))
  if (fs.existsSync(fp)) verifyFixture(label, fp)
}

// ---- 组6：测试页自身约束（speech 技能产物应满足的回归点）----
section('6. 测试页 speech-visual-test.html 自身约束')
{
  const tp = path.join(root, '测试工程/speech-visual-test.html')
  const exists = fs.existsSync(tp)
  check('测试页存在', exists)
  if (exists) {
    const html = fs.readFileSync(tp, 'utf8')
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const slides = doc.querySelectorAll('.slide')
    const slideSubs = doc.querySelectorAll('.slide-subtitles')
    const allSubs = doc.querySelectorAll('[data-zt-role="subtitle"]')
    const items = doc.querySelectorAll('.focus-item')
    const groups = doc.querySelectorAll('.focus-group')
    check(`页数 ${slides.length}`, slides.length >= 6)
    // 每页至少 2 条字幕（测绑定元素问题）
    let minSubs = 99, under = 0
    slides.forEach((s) => {
      const n = s.querySelectorAll('[data-zt-role="subtitle"]').length
      if (n < minSubs) minSubs = n
      if (n < 2) under++
    })
    check(`每页字幕 ≥2（最少 ${minSubs} 条）`, minSubs >= 2, `${under} 页不足`)
    check(`每页都有 .slide-subtitles 容器（${slideSubs.length}）`, slideSubs.length === slides.length)
    // 每条字幕都绑定（绑定元素问题）
    const unbound = Array.from(allSubs).filter((s) => !s.getAttribute('data-zt-bound-to')).length
    check(`全部字幕都已绑定（未绑 ${unbound}）`, unbound === 0)
    // 绑定目标必须存在
    let missing = 0
    allSubs.forEach((s) => {
      const sel = s.getAttribute('data-zt-bound-to')
      if (sel && !doc.querySelector(sel)) missing++
    })
    check(`绑定目标全部存在（缺失 ${missing}）`, missing === 0)
    // 15 种动画效果全覆盖
    const EFFECTS = ['zoom-in','zoom-out','fade-in','fly-left','fly-right','fly-top','fly-bottom','bounce','rotate','wipe','flip','blur-in','slide-spin','highlight-sweep','focus-zoom']
    const used = new Set()
    doc.querySelectorAll('[data-zt-anim-effect]').forEach((e) => used.add(e.getAttribute('data-zt-anim-effect')))
    const missingFx = EFFECTS.filter((f) => !used.has(f))
    check(`15 种动画效果全覆盖（已用 ${used.size}，缺 ${missingFx.length}）`, missingFx.length === 0, missingFx.join(','))
    // 不使用旧属性
    const oldAttrs = ['data-trigger', 'mg-hide', 'mg-pop', 'zoom-focus']
    const oldUsed = oldAttrs.filter((a) => html.indexOf(a) >= 0)
    check(`不使用旧属性（${oldAttrs.join('/')}）`, oldUsed.length === 0, oldUsed.join(','))
    // focus-item 都必须有动画效果（skill 约定：需要强调/动画的元素标 data-zt-anim-effect）
    const noFx = Array.from(items).filter((e) => !e.getAttribute('data-zt-anim-effect')).length
    check(`所有 .focus-item 都有 data-zt-anim-effect（无 ${noFx}）`, noFx === 0)
    // 播放脚本语法合法 + 含 slideTimings / DOM 字幕构建
    const scripts = doc.querySelectorAll('script')
    let lastScript = '', scriptOk = true
    scripts.forEach((sc) => { lastScript = sc.textContent || '' })
    try { new Function(lastScript) } catch (e) { scriptOk = false }
    check('内嵌播放脚本语法合法', scriptOk)
    check('播放脚本含 slideTimings', lastScript.indexOf('slideTimings') >= 0)
    check('播放脚本从 DOM 读字幕构建 subtitles', lastScript.indexOf('data-zt-role="subtitle"') >= 0)
    check('播放脚本含 focus 分支', lastScript.indexOf('focus-') >= 0 && lastScript.indexOf('focusDone') >= 0)
    check('播放脚本含 highlight-sweep 分支', lastScript.indexOf('highlight-sweep') >= 0)
    check('播放脚本翻页清动画状态', lastScript.indexOf('dim-others') >= 0 && lastScript.indexOf('focusDone') >= 0)
  }
}

// ---- 组5：播放脚本（generatePlaybackScript）----
section('5. generatePlaybackScript 播放脚本')
{
  const hp = fs.readFileSync(path.join(root, 'src/htmlProcess.js'), 'utf8')
  const gen = new Function(
    'animEngineSource',
    extractFn(hp, 'generatePlaybackScript') + '\nreturn generatePlaybackScript;'
  )(animEngineSource)
  const samplePath = path.join(root, '样例HTML工程/模板-唐朝不存在风格-v5.5.html')
  const srcHtml = fs.readFileSync(samplePath, 'utf8')
  const htmlScripts = (srcHtml.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || []).map((s) => s.replace(/<\/?script[^>]*>/gi, ''))
  const out = gen(htmlScripts, srcHtml)
  check('播放脚本成功生成', !!out)
  if (out) {
    let ok = true, err = ''
    try { new Function(out) } catch (e) { ok = false; err = e.message }
    check('播放脚本语法合法', ok, err)
    check('含 slideTimings', out.indexOf('const slideTimings=') >= 0 || out.indexOf('const slideTimings =') >= 0)
    check('含 subtitles 构建', out.indexOf('data-zt-role="subtitle"') >= 0 || out.indexOf('subtitles=') >= 0)
    check('含 focus- 分支（focusDone 触发）', out.indexOf('focus-') >= 0 && out.indexOf('focusDone') >= 0)
    check('含 highlight-sweep 分支', out.indexOf('highlight-sweep') >= 0)
    check('含 zt-hl-sweep 类注入', out.indexOf('zt-hl-sweep') >= 0)
    check('时间轴由 audio.currentTime 驱动', out.indexOf('audio.currentTime') >= 0)
    check('含手动翻页清动画状态', out.indexOf('focusDone') >= 0 && out.indexOf('dim-others') >= 0)
  }
}

console.log('\n' + (failed === 0 ? `全部通过（${passed} 项）` : `${failed} 项失败 / ${passed} 项通过`))
process.exit(failed === 0 ? 0 : 1)
