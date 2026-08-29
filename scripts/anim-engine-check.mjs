// 动画引擎收敛回归测试 node scripts/anim-engine-check.mjs
//
// 验证三件事：
//   1. 页面自带的旧原生脚本确实不认识 wipe（复现 bug 的根因）
//   2. patchNativeEngine 能把它整体换成当前引擎，且替换后语法合法
//   3. 新引擎对 wipe / blur-in / highlight-sweep 的行为正确
//
// 直接从 editorRuntime.js 里抠出真实函数体来跑，不复制一份假的 —— 避免测试通过但线上不通过。

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ANIM_ENGINE_PARTS, animEngineSource, animEngineBootstrap } from '../src/animEffects.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0

// 引擎源码是跑在浏览器 iframe / 导出页里的，Node 下补两个最小垫片
globalThis.requestAnimationFrame = function (fn) { return setTimeout(fn, 0) }
globalThis.getComputedStyle = function () { return { transform: 'none' } }

function check(label, cond, extra) {
  if (cond) {
    console.log('  PASS  ' + label)
  } else {
    failed++
    console.log('  FAIL  ' + label + (extra ? '  -> ' + extra : ''))
  }
}

// ---- 从 editorRuntime.js 抠出真实函数体（括号配对，跳过字符串）----
function extractFn(fileSrc, fnName) {
  const sig = new RegExp('function\\s+' + fnName + '\\s*\\([^)]*\\)\\s*\\{')
  const m = sig.exec(fileSrc)
  if (!m) throw new Error('未找到函数 ' + fnName)
  let depth = 0
  let quote = null
  let end = -1
  const start = m.index
  for (let i = m.index + m[0].length - 1; i < fileSrc.length; i++) {
    const c = fileSrc[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  if (end < 0) throw new Error('函数 ' + fnName + ' 括号未配对')
  return fileSrc.slice(start, end + 1)
}

const runtimeSrc = fs.readFileSync(path.join(root, 'src/editorRuntime.js'), 'utf8')
const replaceFnSourceSrc = extractFn(runtimeSrc, 'replaceFnSource')
const patchNativeEngineSrc = extractFn(runtimeSrc, 'patchNativeEngine')

// patchNativeEngine 依赖闭包里的 animEngineParts，用参数注入
const shim = new Function(
  'animEngineParts',
  'var window = { console: console };\n' +
    replaceFnSourceSrc + '\n' +
    patchNativeEngineSrc + '\n' +
    'return { replaceFnSource: replaceFnSource, patchNativeEngine: patchNativeEngine };'
)(ANIM_ENGINE_PARTS)

// ---- 取出样例页自带的原生播放脚本（与 App.jsx getNativePlayerScript 同逻辑）----
const samplePath = path.join(root, '样例HTML工程/模板-唐朝不存在风格-v5.1.html')
const sampleHtml = fs.readFileSync(samplePath, 'utf8')
const scriptBlocks = sampleHtml.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || []
let nativeScript = null
for (const s of scriptBlocks) {
  const inner = s.replace(/<\/?script[^>]*>/gi, '')
  if (/src=/.test(s)) continue
  if (inner.indexOf('startPlayback') >= 0) { nativeScript = inner; break }
}
if (!nativeScript) throw new Error('样例页里没找到原生播放脚本')

console.log('\n[1] 复现 bug：旧原生脚本不认识 wipe')
{
  // 从旧脚本里取出它的 getEffectKeyframes 单独跑
  const oldKf = new Function(
    extractFn(nativeScript, 'getEffectKeyframes') + '\nreturn getEffectKeyframes;'
  )()
  const kf = oldKf('wipe')
  check('旧脚本 getEffectKeyframes("wipe") 落到 default', kf && kf.to && kf.to.transform === 'scale(1.2)', JSON.stringify(kf))
  const oldPlay = extractFn(nativeScript, 'playAnimation')
  check('旧 playAnimation 是 fill:forwards（元素会永久停在放大态）', /fill\s*:\s*'forwards'/.test(oldPlay))
  check('旧 playAnimation 只读 transform/opacity（clipPath 无法表达）', !/clipPath/.test(oldPlay))
  check('旧脚本没有 highlight-sweep 分支', nativeScript.indexOf('highlight-sweep') < 0)
}

console.log('\n[2] 打补丁：把旧引擎换成当前引擎')
const patched = shim.patchNativeEngine(nativeScript)
{
  check('补丁后脚本发生变化', patched !== nativeScript)
  check('补丁后含 wipe 的 clipPath 关键帧', patched.indexOf("clipPath: 'inset(0 100% 0 0)'") >= 0)
  check('补丁后含 blur-in', patched.indexOf("case 'blur-in'") >= 0)
  check('补丁后含 applyStateEffect（类驱动效果）', patched.indexOf('function applyStateEffect') >= 0)
  check('补丁后旧的 scale(1.2) 兜底已消失', patched.indexOf("scale(1.2)'") < 0)
  check('补丁后 playAnimation 改 fill:none', /fill\s*:\s*'none'/.test(extractFn(patched, 'playAnimation')))
  // 语法必须合法，否则注入后整段脚本不执行、播放直接哑掉
  let syntaxOk = true
  let syntaxErr = ''
  try { new Function(patched) } catch (e) { syntaxOk = false; syntaxErr = e.message }
  check('补丁后脚本语法合法', syntaxOk, syntaxErr)
  // 非动画逻辑不能被误伤
  check('slideTimings 未被破坏', patched.indexOf('const slideTimings=') >= 0 || patched.indexOf('const slideTimings =') >= 0)
  check('startPlayback 未被破坏', patched.indexOf('function startPlayback') >= 0)
}

console.log('\n[3] 新引擎行为')
{
  const eng = new Function('return ' + animEngineBootstrap())()
  check("wipe -> from.clipPath = inset(0 100% 0 0)", eng.getEffectKeyframes('wipe').from.clipPath === 'inset(0 100% 0 0)')
  check("blur-in -> from.filter = blur(14px)", eng.getEffectKeyframes('blur-in').from.filter === 'blur(14px)')
  check('未知效果 -> null（不再默默放大）', eng.getEffectKeyframes('不存在的效果') === null)

  // fake 元素：覆盖 playAnimation 会碰到的所有 API
  const logs = []
  const fakeEl = {
    style: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); logs.push('add:' + c) },
      remove(c) { this._s.delete(c); logs.push('remove:' + c) },
      contains(c) { return this._s.has(c) },
    },
    closest() { return null },
    getAnimations() { return [] },
    animate(kf, opt) { logs.push({ kf, opt }); return { cancel() {} } },
  }
  // highlight-sweep 走类驱动，不应产生关键帧动画
  eng.playAnimation(fakeEl, 'highlight-sweep')
  check('highlight-sweep 走类驱动挂 zt-hl-sweep', fakeEl.classList.contains('zt-hl-sweep'))
  check('highlight-sweep 不产生 WAAPI 动画', !logs.some((l) => l && l.kf))

  // wipe 走关键帧，且必须带上 clipPath
  const el2 = { ...fakeEl, classList: { add() {}, remove() {}, contains() { return false } }, closest() { return null }, getAnimations() { return [] }, animate(kf, opt) { logs.push({ kf, opt }) } }
  eng.playAnimation(el2, 'wipe', '1', '0', '0.5', 'ease')
  const anim = logs.filter((l) => l && l.kf).pop()
  check('wipe 产生了动画', !!anim)
  check('wipe 关键帧带 clipPath', !!(anim && anim.kf.some((f) => f.clipPath && f.clipPath !== 'none')))
  check('wipe 用 fill:none（不会永久停在末帧）', !!(anim && anim.opt.fill === 'none'))
  check('恢复时长生效：末帧回到 scale(1)', !!(anim && anim.kf[anim.kf.length - 1].transform.indexOf('scale(1)') >= 0))

  // 未知效果必须静默跳过，不能抛异常打断播放循环
  let threw = false
  try { eng.playAnimation(el2, '瞎写的', '1', '0', '0', 'ease') } catch (e) { threw = true }
  check('未知效果不抛异常', !threw)
}

console.log('\n[4] 导出脚本（htmlProcess 重新生成的播放脚本）')
{
  const src = animEngineSource()
  check('导出引擎含全部 4 个函数', ['function getEffectKeyframes', 'function kfFrameEntries', 'function applyStateEffect', 'function playAnimation'].every((s) => src.indexOf(s) >= 0))
  check('导出引擎语法合法', (() => { try { new Function(src); return true } catch (e) { return false } })())

  // 真正跑一遍 generatePlaybackScript（未导出，从源码里抠出来）
  const hp = fs.readFileSync(path.join(root, 'src/htmlProcess.js'), 'utf8')
  const gen = new Function(
    'animEngineSource',
    extractFn(hp, 'generatePlaybackScript') + '\nreturn generatePlaybackScript;'
  )(animEngineSource)
  const htmlScripts = (sampleHtml.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || []).map((s) =>
    s.replace(/<\/?script[^>]*>/gi, '')
  )
  const out = gen(htmlScripts, sampleHtml)
  check('导出脚本成功生成', !!out)
  if (out) {
    let ok = true
    let err = ''
    try { new Function(out) } catch (e) { ok = false; err = e.message }
    check('导出脚本语法合法', ok, err)
    check('导出脚本含 wipe 的 clipPath', out.indexOf("clipPath: 'inset(0 100% 0 0)'") >= 0)
    check('导出脚本含 highlight-sweep 分支', out.indexOf("'highlight-sweep'") >= 0)
    check('导出脚本已无旧的 scale(1.2) 兜底', out.indexOf("scale(1.2)'") < 0)
    check('导出脚本保留 slideTimings', out.indexOf('const slideTimings=[') >= 0)
  }
}

console.log('\n' + (failed === 0 ? '全部通过' : failed + ' 项失败'))
process.exit(failed === 0 ? 0 : 1)
