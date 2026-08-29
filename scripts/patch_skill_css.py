import io
p = r'C:/Users/ELEX-ZT/.workbuddy/skills/speech-visual-html/SKILL.md'
s = io.open(p, encoding='utf-8').read()
anchor = '.focus-group.dim-others .focus-item-text.zt-focus-active{opacity:1;transform:scale(1.06);color:var(--red);font-weight:700}'
css = (
    "\n"
    ".zt-hl-sweep{position:relative}\n"
    ".zt-hl-sweep::after{content:\"\";position:absolute;left:0;bottom:-0.18em;height:0.12em;width:100%;"
    "background:linear-gradient(90deg,#C41E24,#B8860B);border-radius:2px;transform:scaleX(0);"
    "transform-origin:left center;transition:transform .6s cubic-bezier(.25,.46,.45,.94);pointer-events:none}\n"
    ".zt-hl-sweep.zt-hl-active::after{transform:scaleX(1)}"
)
if 'zt-hl-sweep::after' not in s:
    s = s.replace(anchor, anchor + css, 1)
    io.open(p, 'w', encoding='utf-8').write(s)
    print('CSS added')
else:
    print('CSS already present')
print('getEffectKeyframes:', 'function getEffectKeyframes' in s)
print('wipe clipPath:', "clipPath: 'inset(0 100% 0 0)'" in s)
print('default null:', 'default: return null' in s)
print('fill none:', "fill: 'none'" in s)
print('version v5.5:', 'ztEdit 原生格式规范（v5.5' in s)
print('reset hl:', 'zt-hl-active', 'zt-hl-sweep' in s)
