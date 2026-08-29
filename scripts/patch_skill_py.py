#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import io, sys

path = r"C:/Users/ELEX-ZT/.workbuddy/skills/speech-visual-html/SKILL.md"
with io.open(path, encoding='utf-8') as f:
    s = f.read()

# 1) 替换 playAnimation 整段（brace 计数定位）
start_marker = "  function playAnimation(el, effect, duration, delay, returnSec, easing){"
i = s.index(start_marker)
# brace-count to find matching close at column 2
depth = 0
j = s.index('{', i)
depth = 1
k = j + 1
while depth > 0 and k < len(s):
    if s[k] == '{':
        depth += 1
    elif s[k] == '}':
        depth -= 1
    k += 1
end = k  # index after the closing brace

new_engine = '''  // ===== 原生播放引擎（与 ztEdit src/animEffects.js 完全一致，契约 v5.5）=====
  // 未知效果 → 跳过（不再 silently 放大）；clipPath/filter 透传；支持回位帧(reset)；fill:none
  function getEffectKeyframes(effect) {
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
  }
  function kfFrameEntries(kf, dly, dur, ret, baseTransform) {
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
  }
  function applyStateEffect(el, effect) {
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
  }
  function playAnimation(el, effect, duration, delay, returnSec, easing) {
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
  }
'''

s = s[:i] + new_engine + s[end:]

# 2) 版本号：契约规范标题与 frontmatter
s = s.replace("ztEdit 原生格式规范（v5.4，生成 HTML 必须遵循）", "ztEdit 原生格式规范（v5.5，生成 HTML 必须遵循）")
s = s.replace("# Speech Visual HTML Generator v5.4", "# Speech Visual HTML Generator v5.5")

# 3) 重置逻辑：在 showSlide 重置块补上 zt-hl-active / zt-hl-sweep 移除
old_reset = "      delete el.dataset.animDone; delete el.dataset.focusDone;\n      el.classList.remove('zt-focus-active');\n    });\n    document.querySelectorAll('.focus-group').forEach(function(g){ g.classList.remove('dim-others'); });"
new_reset = "      delete el.dataset.animDone; delete el.dataset.focusDone;\n      el.classList.remove('zt-focus-active', 'zt-hl-active', 'zt-hl-sweep');\n    });\n    document.querySelectorAll('.focus-group').forEach(function(g){ g.classList.remove('dim-others'); });"
if old_reset in s:
    s = s.replace(old_reset, new_reset)
else:
    print("WARN reset block not found")

# 4) 补 .zt-hl-sweep 划线 CSS（在 focus CSS 之后）
css_anchor = ".focus-group.dim-others .focus-item-text.zt-focus-active{opacity:1;transform:scale(1.06);color:var(--red);font-weight:700}"
if css_anchor in s and "zt-hl-sweep" not in s:
    s = s.replace(css_anchor, css_anchor + "\n.zt-hl-sweep{position:relative}\n.zt-hl-sweep::after{content:'';position:absolute;left:0;bottom:-0.18em;height:0.12em;width:100%;background:linear-gradient(90deg,#C41E24,#B8860B);border-radius:2px;transform:scaleX(0);transform-origin:left center;transition:transform .6s cubic-bezier(.25,.46,.45,.94);pointer-events:none}\n.zt-hl-sweep.zt-hl-active::after{transform:scaleX(1)}")
elif "zt-hl-sweep" in s:
    print("INFO zt-hl-sweep already present")

with io.open(path, 'w', encoding='utf-8') as f:
    f.write(s)
print("SKILL.md patched")
