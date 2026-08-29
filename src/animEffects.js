// ztEdit 动画引擎 —— 单一真源（契约 v5.4）
//
// 三处消费同一份，不要再在别处复制 keyframes 表：
//   1. htmlProcess.js    导出时把 animEngineSource() 嵌进重新生成的播放脚本
//   2. editorRuntime.js  预览动画（源码经 postMessage 送达后 eval 成本地函数）
//   3. editorRuntime.js  播放/录屏注入页面自带原生脚本前，用它整体替换脚本里的旧引擎
//   4. App.jsx           动画下拉清单 ANIM_EFFECTS
//
// ===== 历史坑（改这里之前必读）=====
// 曾经 keyframes 表在 editorRuntime / htmlProcess 各存一份，页面自带的原生播放脚本里
// 还冻着生成时那一版的第三份。新增 wipe 时只改了前两份，于是：
//   预览对（走 runtime）、导出对（走重新生成的脚本）、播放录屏错（走页面里的旧脚本）。
// 旧脚本的 default 分支恰好是 scale(1)→scale(1.2)，表现就是「选了擦除滑入，录出来是放大」。
// 且旧 playAnimation 是 fill:'forwards' + 只取 transform/opacity，元素会永久停在放大态，
// clipPath/filter 类效果（wipe / blur-in）在旧实现里物理上无法表达。
//
// 收敛后：任何一端新增/修改动画，只改本文件。

// 动画效果清单（value 即写入 data-zt-anim-effect 的值）
export const ANIM_EFFECTS = [
  ['zoom-in', '放大1.2倍'],
  ['zoom-out', '缩小'],
  ['fade-in', '淡入'],
  ['fly-left', '飞入左侧'],
  ['fly-right', '飞入右侧'],
  ['fly-top', '飞入上方'],
  ['fly-bottom', '飞入下方'],
  ['bounce', '弹跳'],
  ['rotate', '旋转'],
  ['wipe', '擦除滑入'],
  ['flip', '3D翻转'],
  ['blur-in', '虚化聚焦'],
  ['slide-spin', '旋转滑入'],
  ['highlight-sweep', '划线强调（强调）'],
  ['focus-zoom', '聚焦放大（强调）'],
  ['', '（无动画）'],
]

// 引擎版本，随 ANIM_EFFECTS 同步 bump；iframe 里会打出来便于排障
export const ANIM_ENGINE_VERSION = 'v5.4'

// 引擎源码按函数切片，供「整体嵌入导出脚本」与「定点替换原生脚本里的旧函数」两种用法复用
export const ANIM_ENGINE_PARTS = {
  keyframes: `function getEffectKeyframes(effect) {
  switch (effect) {
    case 'zoom-in': return { from: { transform: 'scale(0.6)', opacity: 0 }, to: { transform: 'scale(1.3)', opacity: 1 } }
    case 'zoom-out': return { from: { transform: 'scale(1)', opacity: 1 }, to: { transform: 'scale(0.6)', opacity: 0 } }
    case 'fade-in': return { from: { opacity: 0 }, to: { opacity: 1 } }
    case 'fly-left': return { from: { transform: 'translateX(-120px)', opacity: 0 }, to: { transform: 'translateX(0)', opacity: 1 } }
    case 'fly-right': return { from: { transform: 'translateX(120px)', opacity: 0 }, to: { transform: 'translateX(0)', opacity: 1 } }
    case 'fly-top': return { from: { transform: 'translateY(-120px)', opacity: 0 }, to: { transform: 'translateY(0)', opacity: 1 } }
    case 'fly-bottom': return { from: { transform: 'translateY(120px)', opacity: 0 }, to: { transform: 'translateY(0)', opacity: 1 } }
    case 'bounce': return { from: { transform: 'scale(0.8)', opacity: 0 }, to: { transform: 'scale(1.15)', opacity: 1 } }
    case 'rotate': return { from: { transform: 'rotate(-15deg) scale(0.9)', opacity: 0 }, to: { transform: 'rotate(0deg) scale(1)', opacity: 1 } }
    case 'wipe': return { from: { transform: 'translateX(-24px)', clipPath: 'inset(0 100% 0 0)', opacity: 1 }, to: { transform: 'translateX(0)', clipPath: 'inset(0 0% 0 0)', opacity: 1 } }
    case 'flip': return { from: { transform: 'perspective(900px) rotateY(88deg) scale(0.94)', opacity: 0 }, to: { transform: 'perspective(900px) rotateY(0deg) scale(1)', opacity: 1 } }
    case 'blur-in': return { from: { transform: 'scale(1.08)', filter: 'blur(14px)', opacity: 0 }, to: { transform: 'scale(1)', filter: 'blur(0px)', opacity: 1 } }
    case 'slide-spin': return { from: { transform: 'translateX(-140px) rotate(-14deg) scale(0.85)', opacity: 0 }, to: { transform: 'translateX(0) rotate(0deg) scale(1)', opacity: 1 } }
    default: return null
  }
}`,
  frames: `function kfFrameEntries(kf, dly, dur, ret, baseTransform) {
  var totalDur = dur + ret
  var startOff = dly > 0 ? dly / totalDur : 0
  var endOff = (dly + dur) / totalDur
  var usesExtra = !!(kf.from.clipPath || kf.from.filter || kf.to.clipPath || kf.to.filter)
  function frame(offset, src, reset) {
    var f = { offset: offset, transform: baseTransform + (reset ? 'scale(1)' : (src.transform || 'none')), opacity: reset ? 1 : (src.opacity != null ? src.opacity : 1) }
    if (usesExtra) { f.clipPath = reset ? 'none' : (src.clipPath || 'none'); f.filter = reset ? 'none' : (src.filter || 'none') }
    return f
  }
  var keyframes = []
  if (dly > 0) keyframes.push(frame(0, null, true))
  keyframes.push(frame(startOff, kf.from, false))
  keyframes.push(frame(endOff, kf.to, false))
  if (ret > 0) keyframes.push(frame(1, null, true))
  return keyframes
}`,
  state: `function applyStateEffect(el, effect) {
  if (!el || !effect) return false
  if (effect === 'highlight-sweep') {
    if (!el.classList.contains('zt-hl-sweep')) {
      el.classList.add('zt-hl-sweep')
      requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.add('zt-hl-active') }) })
    } else {
      el.classList.add('zt-hl-active')
    }
    return true
  }
  if (effect.indexOf('focus-') === 0) {
    var grp = el.closest ? el.closest('.focus-group') : null
    if (grp) grp.classList.add('dim-others')
    el.classList.add('zt-focus-active')
    return true
  }
  return false
}`,
  play: `function playAnimation(el, effect, duration, delay, returnSec, easing) {
  if (!el) return
  if (!effect) return
  if (applyStateEffect(el, effect)) return
  var kf = getEffectKeyframes(effect)
  if (!kf) { if (typeof console !== 'undefined' && console.warn) console.warn('[ztEdit] 未知动画效果：', effect); return }
  var dur = parseFloat(duration) || 1
  var dly = parseFloat(delay) || 0
  var ret = parseFloat(returnSec) || 0
  var ease = easing || 'ease'
  var totalDur = dur + ret
  var baseTransform = el.style.transform || (getComputedStyle(el).transform && getComputedStyle(el).transform !== 'none' ? getComputedStyle(el).transform : '')
  if (baseTransform) baseTransform += ' '
  if (el.getAnimations) el.getAnimations().forEach(function (a) { a.cancel() })
  el.animate(kfFrameEntries(kf, dly, dur, ret, baseTransform), { duration: totalDur * 1000, easing: ease, fill: 'none' })
}`,
}

const ENGINE_ORDER = ['keyframes', 'frames', 'state', 'play']

// 完整引擎源码（四段按依赖顺序拼接）
export function animEngineSource() {
  return ENGINE_ORDER.map(function (k) { return ANIM_ENGINE_PARTS[k] }).join('\n')
}

// 供 iframe eval 的引导代码：把引擎装进一个对象返回，不污染页面全局
export function animEngineBootstrap() {
  return (
    '(function(){\n' +
    animEngineSource() +
    '\nreturn { version: ' + JSON.stringify(ANIM_ENGINE_VERSION) +
    ', getEffectKeyframes: getEffectKeyframes, kfFrameEntries: kfFrameEntries' +
    ', applyStateEffect: applyStateEffect, playAnimation: playAnimation };\n' +
    '})()'
  )
}
