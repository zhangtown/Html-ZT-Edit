import io

tmpl = r"C:/Users/ELEX-ZT/.workbuddy/skills/speech-visual-html/模板-唐朝不存在风格-v5.1.html"
s = io.open(tmpl, encoding='utf-8').read()

def block_end(start_idx):
    j = s.index('{', start_idx)
    depth = 1
    k = j + 1
    while depth > 0 and k < len(s):
        if s[k] == '{':
            depth += 1
        elif s[k] == '}':
            depth -= 1
        k += 1
    return k

i = s.index('function getEffectKeyframes(effect){')
end1 = block_end(i)
i2 = s.index('function playAnimation', end1)
end2 = block_end(i2)

new_engine = (
"function getEffectKeyframes(effect) {\n"
"  switch (effect) {\n"
"    case 'zoom-in': return { from: { transform: 'scale(0.6)', opacity: 0 }, to: { transform: 'scale(1.3)', opacity: 1 } }\n"
"    case 'zoom-out': return { from: { transform: 'scale(1)', opacity: 1 }, to: { transform: 'scale(0.6)', opacity: 0 } }\n"
"    case 'fade-in': return { from: { opacity: 0 }, to: { opacity: 1 } }\n"
"    case 'fly-left': return { from: { transform: 'translateX(-120px)', opacity: 0 }, to: { transform: 'translateX(0)', opacity: 1 } }\n"
"    case 'fly-right': return { from: { transform: 'translateX(120px)', opacity: 0 }, to: { transform: 'translateX(0)', opacity: 1 } }\n"
"    case 'fly-top': return { from: { transform: 'translateY(-120px)', opacity: 0 }, to: { transform: 'translateY(0)', opacity: 1 } }\n"
"    case 'fly-bottom': return { from: { transform: 'translateY(120px)', opacity: 0 }, to: { transform: 'translateY(0)', opacity: 1 } }\n"
"    case 'bounce': return { from: { transform: 'scale(0.8)', opacity: 0 }, to: { transform: 'scale(1.15)', opacity: 1 } }\n"
"    case 'rotate': return { from: { transform: 'rotate(-15deg) scale(0.9)', opacity: 0 }, to: { transform: 'rotate(0deg) scale(1)', opacity: 1 } }\n"
"    case 'wipe': return { from: { transform: 'translateX(-24px)', clipPath: 'inset(0 100% 0 0)', opacity: 1 }, to: { transform: 'translateX(0)', clipPath: 'inset(0 0% 0 0)', opacity: 1 } }\n"
"    case 'flip': return { from: { transform: 'perspective(900px) rotateY(88deg) scale(0.94)', opacity: 0 }, to: { transform: 'perspective(900px) rotateY( 0deg) scale(1)', opacity: 1 } }\n"
"    case 'blur-in': return { from: { transform: 'scale(1.08)', filter: 'blur(14px)', opacity: 0 }, to: { transform: 'scale(1)', filter: 'blur(0px)', opacity: 1 } }\n"
"    case 'slide-spin': return { from: { transform: 'translateX(-140px) rotate(-14deg) scale(0.85)', opacity: 0 }, to: { transform: 'translateX(0) rotate(0deg) scale(1)', opacity: 1 } }\n"
"    default: return null\n"
"  }\n"
"}\n"
"function kfFrameEntries(kf, dly, dur, ret, baseTransform) {\n"
"  var totalDur = dur + ret\n"
"  var startOff = dly > 0 ? dly / totalDur : 0\n"
"  var endOff = (dly + dur) / totalDur\n"
"  var usesExtra = !!(kf.from.clipPath || kf.from.filter || kf.to.clipPath || kf.to.filter)\n"
"  function frame(offset, src, reset) {\n"
"    var f = { offset: offset, transform: baseTransform + (reset ? 'scale(1)' : (src.transform || 'none')), opacity: reset ? 1 : (src.opacity != null ? src.opacity : 1) }\n"
"    if (usesExtra) { f.clipPath = reset ? 'none' : (src.clipPath || 'none'); f.filter = reset ? 'none' : (src.filter || 'none') }\n"
"    return f\n"
"  }\n"
"  var keyframes = []\n"
"  if (dly > 0) keyframes.push(frame(0, null, true))\n"
"  keyframes.push(frame(startOff, kf.from, false))\n"
"  keyframes.push(frame(endOff, kf.to, false))\n"
"  if (ret > 0) keyframes.push(frame(1, null, true))\n"
"  return keyframes\n"
"}\n"
"function applyStateEffect(el, effect) {\n"
"  if (!el || !effect) return false\n"
"  if (effect === 'highlight-sweep') {\n"
"    if (!el.classList.contains('zt-hl-sweep')) {\n"
"      el.classList.add('zt-hl-sweep')\n"
"      requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.add('zt-hl-active') }) })\n"
"    } else { el.classList.add('zt-hl-active') }\n"
"    return true\n"
"  }\n"
"  if (effect.indexOf('focus-') === 0) {\n"
"    var grp = el.closest ? el.closest('.focus-group') : null\n"
"    if (grp) grp.classList.add('dim-others')\n"
"    el.classList.add('zt-focus-active')\n"
"    return true\n"
"  }\n"
"  return false\n"
"}\n"
"function playAnimation(el, effect, duration, delay, returnSec, easing) {\n"
"  if (!el) return\n"
"  if (!effect) return\n"
"  if (applyStateEffect(el, effect)) return\n"
"  var kf = getEffectKeyframes(effect)\n"
"  if (!kf) { if (typeof console !== 'undefined' && console.warn) console.warn('[ztEdit] 未知动画效果：', effect); return }\n"
"  var dur = parseFloat(duration) || 1\n"
"  var dly = parseFloat(delay) || 0\n"
"  var ret = parseFloat(returnSec) || 0\n"
"  var ease = easing || 'ease'\n"
"  var totalDur = dur + ret\n"
"  var baseTransform = el.style.transform || (getComputedStyle(el).transform && getComputedStyle(el).transform !== 'none' ? getComputedStyle(el).transform : '')\n"
"  if (baseTransform) baseTransform += ' '\n"
"  if (el.getAnimations) el.getAnimations().forEach(function (a) { a.cancel() })\n"
"  el.animate(kfFrameEntries(kf, dly, dur, ret, baseTransform), { duration: totalDur * 1000, easing: ease, fill: 'none' })\n"
"}\n"
)

s = s[:i] + new_engine + s[  end2:]

old_reset = "el.classList.remove('zt-focus-active');var g=el.closest('.focus-group');if(g)g.classList.remove('dim-others')"
new_reset = "el.classList.remove('zt-focus-active','zt-hl-active','zt-hl-sweep');var g=el.closest('.focus-group');if(g)g.classList.remove('dim-others')"
if old_reset in s:
    s = s.replace(old_reset, new_reset)

anchor = ".focus-group.dim-others .focus-item-text.zt-focus-active{opacity:1;transform:scale(1.06);color:var(--red);font-weight:700}"
css = (
    "\n.zt-hl-sweep{position:relative}\n"
    ".zt-hl-sweep::after{content:\"\";position:absolute;left:0;bottom:-0.18em;height:0.12em;width:100%;"
    "background:linear-gradient(90deg,#C41E24,#B8860B);border-radius:2px;transform:scaleX(0);"
    "transform-origin:left center;transition:transform .6s cubic-bezier(.25,.46,.45,.94);pointer-events:none}\n"
    ".zt-hl-sweep.zt-hl-active::after{transform:scaleX(1)}"
)
if 'zt-hl-sweep::after' not in s:
    s = s.replace(anchor, anchor + css, 1)

io.open(tmpl, 'w', encoding='utf-8').write(s)
print('template patched')
print('default null:', 'default: return null' in s)
print('wipe clipPath:', "clipPath: 'inset(0 100% 0 0)'" in s)
print('fill none:', "fill: 'none'" in s)
print('hl css:', 'zt-hl-sweep::after' in s)
print('hl reset:', "'zt-hl-active','zt-hl-sweep'" in s)
