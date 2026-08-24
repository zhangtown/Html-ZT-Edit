/*
 * 编辑器运行时：以纯脚本形式注入到 iframe（经 Vite ?raw 导入为字符串）。
 * 职责：
 *  - 选中(单击单选 / Ctrl+单击多选) / 拖动(前置 translate 平移，保留原有旋转缩放，绝不重排兄弟)
 *  - 撤销(Ctrl+Z)+重做(Ctrl+Shift+Z)：统一快照(含存在性标记)，支持位置/尺寸/样式/文字/增删
 *  - 对齐与分布(L/C/R/T/M/B/H/V) + 等高/等宽/等尺寸(E/W/Q)
 *  - 文字编辑(双击进入，可改可删) / 元素删除(Delete) / 复制粘贴(Ctrl+C/V，可跨页)
 *  - 属性面板：setStyles(大小/颜色/字体) / setText
 *  - 页面(slide)前进后退 / 网格 / 与父窗口通信 / 序列化(供草稿保存)
 * 注意：此文件作为普通脚本注入 iframe，不能使用 import/export。
 */
(function () {
  var GRID_SIZE = 20
  var gridOn = false
  var current = 0
  var slides = []
  var selectedList = [] // 多选：当前选中的所有元素
  var history = [] // 撤销栈：{before:[snaps], after:[snaps], selEls:[...]}
  var redoStack = []
  var clipboard = [] // 复制缓冲区：元素 outerHTML 数组
  var textEditing = null // 正在文字编辑的元素
  var aspectRatioLocked = false // 属性面板「锁定纵横比」开关
  var resizeOverlay = null // 边缘/角点拖拽调整大小的手柄层
  var resizeHandles = {}

  function post(msg) {
    window.parent.postMessage(msg, '*')
  }

  function getSlides() {
    return Array.prototype.slice.call(document.querySelectorAll('.slide'))
  }

  function show(i) {
    slides = getSlides()
    if (!slides.length) return
    if (i < 0) i = 0
    if (i > slides.length - 1) i = slides.length - 1
    slides.forEach(function (s) {
      s.classList.remove('active')
    })
    slides[i].classList.add('active')
    current = i
    post({ type: 'pages', total: slides.length, current: current })
  }

  // ---- 元素信息（含计算样式，供属性面板回显）----
  function getInfo(el) {
    var cs = getComputedStyle(el)
    return {
      tag: el.tagName,
      cls: typeof el.className === 'string' ? el.className : '',
      id: el.id || '',
      position: cs.position,
      transform: el.style.transform || (cs.transform && cs.transform !== 'none' ? cs.transform : ''),
      width: cs.width,
      height: cs.height,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      text: el.textContent,
    }
  }

  function postSelection() {
    var primary = selectedList.length ? getInfo(selectedList[selectedList.length - 1]) : null
    post({ type: 'selection', count: selectedList.length, primary: primary })
    updateResizeHandles()
  }

  // ---- 边缘/角点拖拽调整大小（手柄层） ----
  function getCursorForDir(dir) {
    var c = {
      nw: 'nw-resize', n: 'n-resize', ne: 'ne-resize',
      e: 'e-resize', se: 'se-resize', s: 's-resize',
      sw: 'sw-resize', w: 'w-resize',
    }
    return c[dir] || 'default'
  }

  function ensureResizeOverlay() {
    if (resizeOverlay) return
    resizeOverlay = document.createElement('div')
    resizeOverlay.id = 'zt-resize-overlay'
    resizeOverlay.style.cssText =
      'position:fixed;top:0;left:0;width:100%;height:100%;' +
      'pointer-events:none;z-index:2147483647;'
    document.body.appendChild(resizeOverlay)
    var dirs = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
    dirs.forEach(function (dir) {
      var h = document.createElement('div')
      h.dataset.dir = dir
      h.style.cssText =
        'position:absolute;width:12px;height:12px;background:#C41E24;' +
        'border:1.5px solid #fff;box-sizing:border-box;' +
        'pointer-events:auto;cursor:' + getCursorForDir(dir) + ';z-index:1;'
      h.addEventListener('pointerdown', function (ev) {
        ev.stopPropagation()
        ev.preventDefault()
        var primary = selectedList.length ? selectedList[selectedList.length - 1] : null
        if (!primary) return
        startResize(dir, primary, ev)
      })
      resizeOverlay.appendChild(h)
      resizeHandles[dir] = h
    })
  }

  function positionResizeHandles(el) {
    if (!el) {
      if (resizeOverlay) resizeOverlay.style.display = 'none'
      return
    }
    ensureResizeOverlay()
    var r = el.getBoundingClientRect()
    var s = 6 // 手柄半边长
    var pos = {
      nw: [r.left - s, r.top - s],
      n: [r.left + r.width / 2 - s, r.top - s],
      ne: [r.right - s, r.top - s],
      e: [r.right - s, r.top + r.height / 2 - s],
      se: [r.right - s, r.bottom - s],
      s: [r.left + r.width / 2 - s, r.bottom - s],
      sw: [r.left - s, r.bottom - s],
      w: [r.left - s, r.top + r.height / 2 - s],
    }
    for (var dir in pos) {
      resizeHandles[dir].style.left = pos[dir][0] + 'px'
      resizeHandles[dir].style.top = pos[dir][1] + 'px'
    }
    resizeOverlay.style.display = 'block'
  }

  function updateResizeHandles() {
    if (!selectedList.length) {
      if (resizeOverlay) resizeOverlay.style.display = 'none'
      return
    }
    // 手柄显示在主选元素上（多选时最后一个）
    positionResizeHandles(selectedList[selectedList.length - 1])
  }

  // 拖拽缩放：所有选中元素同步改变相同的宽高增量
  function startResize(dir, primary, e) {
    var els = selectedList.slice()
    if (els.length < 1) return
    var rect = primary.getBoundingClientRect()
    var sx = e.clientX
    var sy = e.clientY
    var startW = rect.width
    var startH = rect.height
    var ratio = startW / startH
    var isCorner = dir.length === 2
    var before = els.map(snapStyle)
    // 记录每个选中元素的初始宽高
    var init = els.map(function (el) {
      var r = el.getBoundingClientRect()
      return { w: r.width, h: r.height }
    })

    function move(ev) {
      var dx = ev.clientX - sx
      var dy = ev.clientY - sy
      var newW = startW
      var newH = startH
      if (dir.indexOf('e') >= 0) newW = startW + dx
      if (dir.indexOf('w') >= 0) newW = startW - dx
      if (dir.indexOf('s') >= 0) newH = startH + dy
      if (dir.indexOf('n') >= 0) newH = startH - dy

      var lock = aspectRatioLocked || ev.shiftKey
      if (lock && isCorner) {
        // 角点 + 锁定纵横比：以主方向为准
        if (Math.abs(dx) > Math.abs(dy)) {
          newH = newW / ratio
        } else {
          newW = newH * ratio
        }
      }
      if (newW < 8) newW = 8
      if (newH < 8) newH = 8

      var dw = newW - startW
      var dh = newH - startH
      els.forEach(function (el, i) {
        // 对每个选中元素应用相同的增量
        var w = init[i].w + dw
        var h = init[i].h + dh
        if (w < 8) w = 8
        if (h < 8) h = 8
        el.style.width = w + 'px'
        el.style.height = h + 'px'
        // 拖拽缩放时覆盖 max-width / max-height 约束
        el.style.setProperty('max-width', 'none', 'important')
        el.style.setProperty('max-height', 'none', 'important')
      })
      positionResizeHandles(primary)
    }

    function up() {
      var after = els.map(snapStyle)
      pushHistory(before, after, els.slice())
      postSelection()
      post({ type: 'changed' })
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
    }

    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }

  // 图片 + 布局容器联动：img 的直接父级若是 flex 容器，选中时一并带上
  function layoutWrapperOf(el) {
    if (!el || el.tagName !== 'IMG') return null
    var p = el.parentElement
    if (!p || p.tagName !== 'DIV') return null
    var cs = getComputedStyle(p)
    if (cs.display === 'flex' || cs.display === 'inline-flex') return p
    return null
  }

  function selectOnly(el) {
    selectedList.forEach(function (x) {
      if (x !== el) x.classList.remove('zt-selected')
    })
    selectedList = [el]
    el.classList.add('zt-selected')
    postSelection()
  }

  function addToSelection(el) {
    if (selectedList.indexOf(el) < 0) {
      selectedList.push(el)
      el.classList.add('zt-selected')
    }
    postSelection()
  }

  function removeFromSelection(el) {
    var i = selectedList.indexOf(el)
    if (i >= 0) {
      selectedList.splice(i, 1)
      el.classList.remove('zt-selected')
    }
    postSelection()
  }

  function toggleSelect(el) {
    if (selectedList.indexOf(el) >= 0) removeFromSelection(el)
    else addToSelection(el)
  }

  function deselectAll() {
    selectedList.forEach(function (el) {
      el.classList.remove('zt-selected')
    })
    selectedList = []
    postSelection()
  }

  function isSelected(el) {
    return selectedList.indexOf(el) >= 0
  }

  function isEditable(t) {
    if (!t || !t.tagName) return false
    var forbid = ['HTML', 'BODY', 'HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'BR', 'HR']
    if (forbid.indexOf(t.tagName) >= 0) return false
    if (t.classList && t.classList.contains('slide')) return false
    return !!t.closest('.slide')
  }

  // ---- 统一快照（含存在性标记，支持增删/样式/文字/位置）----
  function snapStyle(el) {
    return {
      el: el,
      style: el.getAttribute('style') || '',
      text: null,
      parent: el.parentNode,
      next: el.nextSibling,
      present: true,
    }
  }

  function applySnaps(snaps) {
    snaps.forEach(function (s) {
      if (!s.present) {
        if (s.el && s.el.parentNode) s.el.parentNode.removeChild(s.el)
      } else {
        if (s.el && !s.el.parentNode && s.parent) s.parent.insertBefore(s.el, s.next)
        if (s.el) {
          s.el.setAttribute('style', s.style)
          if (s.text != null && s.el.textContent !== s.text) s.el.textContent = s.text
        }
      }
    })
  }

  function selectThese(els) {
    selectedList.forEach(function (x) {
      x.classList.remove('zt-selected')
    })
    selectedList = (els || []).filter(function (el) {
      return el && el.parentNode && isEditable(el)
    })
    selectedList.forEach(function (el) {
      el.classList.add('zt-selected')
    })
    postSelection()
  }

  // before/after: 快照数组；selEls: 操作后应选中的元素
  function pushHistory(before, after, selEls) {
    history.push({ before: before, after: after, selEls: selEls || [] })
    redoStack = []
  }

  function undo() {
    if (!history.length) return
    var e = history.pop()
    applySnaps(e.before)
    selectThese(e.selEls)
    redoStack.push(e)
    post({ type: 'changed' })
  }

  function redo() {
    if (!redoStack.length) return
    var e = redoStack.pop()
    applySnaps(e.after)
    selectThese(e.selEls)
    history.push(e)
    post({ type: 'changed' })
  }

  // 在现有变换基础上叠加平移（前置 translate，不依赖 DOMMatrix，避免空字符串报错）
  // 前置 translate 处于父级坐标空间，等价于按屏幕像素精确位移，且保留元素原有旋转/缩放。
  function translateBy(el, dx, dy) {
    var t = el.style.transform || ''
    if (!t) {
      var ct = getComputedStyle(el).transform
      t = ct && ct !== 'none' ? ct : ''
    }
    el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) ' + t
  }

  function safeMatrix(t) {
    return t && t !== 'none' ? new DOMMatrixReadOnly(t) : new DOMMatrixReadOnly()
  }

  // ---- 拖动（支持整体多选拖动）----
  function startDrag(els, e) {
    var dragging = false
    var before = null
    var bases = null
    var sx = e.clientX
    var sy = e.clientY

    function move(ev) {
      var dx = ev.clientX - sx
      var dy = ev.clientY - sy
      if (!dragging) {
        if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return
        dragging = true
        before = els.map(snapStyle)
        bases = els.map(function (el) {
          return safeMatrix(getComputedStyle(el).transform)
        })
      }
      els.forEach(function (el, i) {
        var b = bases[i]
        var nx = b.e + dx
        var ny = b.f + dy
        if (gridOn) {
          nx = Math.round(nx / GRID_SIZE) * GRID_SIZE
          ny = Math.round(ny / GRID_SIZE) * GRID_SIZE
        }
        el.style.transform =
          'matrix(' + b.a + ',' + b.b + ',' + b.c + ',' + b.d + ',' + nx + ',' + ny + ')'
      })
    }

    function up() {
      if (dragging) {
        var after = els.map(snapStyle)
        pushHistory(before, after, els)
        post({ type: 'changed' })
      }
      postSelection()
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
    }

    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
    e.preventDefault()
  }

  // ---- 对齐与分布 ----
  function align(mode) {
    var els = selectedList
    if (els.length < 2) return
    var before = els.map(snapStyle)
    var rects = els.map(function (el) {
      return el.getBoundingClientRect()
    })
    var lefts = rects.map(function (r) { return r.left })
    var rights = rects.map(function (r) { return r.right })
    var tops = rects.map(function (r) { return r.top })
    var bottoms = rects.map(function (r) { return r.bottom })
    var cxs = rects.map(function (r) { return r.left + r.width / 2 })
    var cys = rects.map(function (r) { return r.top + r.height / 2 })

    function applyDx(dxs) {
      els.forEach(function (el, i) {
        if (dxs[i]) translateBy(el, dxs[i], 0)
      })
    }
    function applyDy(dys) {
      els.forEach(function (el, i) {
        if (dys[i]) translateBy(el, 0, dys[i])
      })
    }

    if (mode === 'L') {
      var L = Math.min.apply(null, lefts)
      applyDx(lefts.map(function (v) { return L - v }))
    } else if (mode === 'R') {
      var R = Math.max.apply(null, rights)
      applyDx(rights.map(function (v) { return R - v }))
    } else if (mode === 'C') {
      var cx = (Math.min.apply(null, lefts) + Math.max.apply(null, rights)) / 2
      applyDx(cxs.map(function (v) { return cx - v }))
    } else if (mode === 'T') {
      var T = Math.min.apply(null, tops)
      applyDy(tops.map(function (v) { return T - v }))
    } else if (mode === 'B') {
      var B = Math.max.apply(null, bottoms)
      applyDy(bottoms.map(function (v) { return B - v }))
    } else if (mode === 'M') {
      var cy = (Math.min.apply(null, tops) + Math.max.apply(null, bottoms)) / 2
      applyDy(cys.map(function (v) { return cy - v }))
    } else if (mode === 'H') {
      // 横向分布：按中心排序，首尾不动，中间等间距
      var order = els.map(function (_, i) { return i }).sort(function (a, b) { return cxs[a] - cxs[b] })
      var n = order.length
      if (n >= 3) {
        var c0 = cxs[order[0]]
        var c1 = cxs[order[n - 1]]
        var step = (c1 - c0) / (n - 1)
        var dxs = els.map(function () { return 0 })
        for (var k = 1; k < n - 1; k++) {
          var idx = order[k]
          dxs[idx] = c0 + step * k - cxs[idx]
        }
        applyDx(dxs)
      }
    } else if (mode === 'V') {
      var orderV = els.map(function (_, i) { return i }).sort(function (a, b) { return cys[a] - cys[b] })
      var nv = orderV.length
      if (nv >= 3) {
        var y0 = cys[orderV[0]]
        var y1 = cys[orderV[nv - 1]]
        var stepV = (y1 - y0) / (nv - 1)
        var dys = els.map(function () { return 0 })
        for (var kk = 1; kk < nv - 1; kk++) {
          var ix = orderV[kk]
          dys[ix] = y0 + stepV * kk - cys[ix]
        }
        applyDy(dys)
      }
    } else if (mode === 'E') {
      var h = Math.max.apply(null, rects.map(function (r) { return r.height }))
      els.forEach(function (el) { el.style.height = h + 'px' })
    } else if (mode === 'W') {
      var w = Math.max.apply(null, rects.map(function (r) { return r.width }))
      els.forEach(function (el) { el.style.width = w + 'px' })
    } else if (mode === 'Q') {
      var wq = Math.max.apply(null, rects.map(function (r) { return r.width }))
      var hq = Math.max.apply(null, rects.map(function (r) { return r.height }))
      els.forEach(function (el) { el.style.width = wq + 'px'; el.style.height = hq + 'px' })
    }
    var after = els.map(snapStyle)
    pushHistory(before, after, els)
    post({ type: 'changed' })
    postSelection()
  }

  // ---- 样式修改（大小/颜色/字体）----
  // ---- 样式修改（大小/颜色/字体）----
  var fontStyleEl = null // 用 style 规则 + data-zt-font 属性强制覆盖字体

  function ensureFontStyle() {
    if (fontStyleEl) return
    fontStyleEl = document.createElement('style')
    fontStyleEl.id = 'zt-editor-fonts'
    fontStyleEl.textContent = [
      '[data-zt-ff] { font-family: var(--zt-ff) !important; }',
      '[data-zt-fs]  { font-size:    var(--zt-fs)  !important; }',
      '[data-zt-fw]  { font-weight:  var(--zt-fw)  !important; }',
    ].join('\n')
    document.head.appendChild(fontStyleEl)
  }

  function setStyles(styles) {
    if (!selectedList.length) return
    var before = selectedList.map(snapStyle)
    selectedList.forEach(function (el) {
      for (var k in styles) {
        if (!styles.hasOwnProperty(k)) continue
        var v = styles[k]
        if (v === '' || v == null) {
          el.style.removeProperty(k)
          // 同时清除字体 data 属性
          if (k === 'fontFamily') { el.removeAttribute('data-zt-ff'); el.style.removeProperty('--zt-ff') }
          if (k === 'fontSize')   { el.removeAttribute('data-zt-fs'); el.style.removeProperty('--zt-fs') }
          if (k === 'fontWeight') { el.removeAttribute('data-zt-fw'); el.style.removeProperty('--zt-fw') }
        } else if (k === 'fontFamily' || k === 'fontSize' || k === 'fontWeight') {
          // 字体相关：用 style 规则 + data 属性 + !important 双重保证
          ensureFontStyle()
          var attr = { fontFamily: 'ff', fontSize: 'fs', fontWeight: 'fw' }[k]
          var prop = { fontFamily: '--zt-ff', fontSize: '--zt-fs', fontWeight: '--zt-fw' }[k]
          el.setAttribute('data-zt-' + attr, '1')
          el.style.setProperty(prop, v, 'important')
          // 同时设置 inline style 作为后备
          el.style.setProperty(k, v, 'important')
        } else {
          el.style.setProperty(k, v)
        }
        // 设置明确宽高时，覆盖 max-width / max-height 约束（改为 none+important 强制解除）
        if (k === 'width' || k === 'height') {
          el.style.setProperty('max-' + k, 'none', 'important')
        }
      }
    })
    var after = selectedList.map(snapStyle)
    pushHistory(before, after, selectedList.slice())
    postSelection()
    post({ type: 'changed' })
  }

  // ---- 文字内容修改 ----
  function setText(val) {
    if (!selectedList.length) return
    var before = selectedList.map(function (el) {
      return { el: el, style: el.getAttribute('style') || '', text: el.textContent, parent: el.parentNode, next: el.nextSibling, present: true }
    })
    selectedList.forEach(function (el) { el.textContent = val })
    var after = selectedList.map(function (el) {
      return { el: el, style: el.getAttribute('style') || '', text: val, parent: el.parentNode, next: el.nextSibling, present: true }
    })
    pushHistory(before, after, selectedList.slice())
    postSelection()
    post({ type: 'changed' })
  }

  // ---- 元素删除 ----
  function deleteSelected() {
    if (!selectedList.length) return
    var before = selectedList.map(function (el) {
      return { el: el, style: el.getAttribute('style') || '', text: null, parent: el.parentNode, next: el.nextSibling, present: true }
    })
    selectedList.forEach(function (el) { if (el.parentNode) el.parentNode.removeChild(el) })
    var after = selectedList.map(function (el) {
      return { el: el, style: el.getAttribute('style') || '', text: null, parent: el.parentNode, next: el.nextSibling, present: false }
    })
    pushHistory(before, after, [])
    deselectAll()
    post({ type: 'changed' })
  }

  // ---- 复制 / 粘贴（可跨页）----
  function copySelection() {
    if (!selectedList.length) return
    clipboard = selectedList.map(function (el) { return el.outerHTML })
    post({ type: 'clipboard', count: clipboard.length })
  }

  function paste() {
    if (!clipboard.length) return
    var slide = slides[current]
    if (!slide) return
    var before = []
    var after = []
    var newEls = []
    clipboard.forEach(function (html) {
      var tmp = document.createElement('div')
      tmp.innerHTML = html
      var node = tmp.firstElementChild
      if (!node) return
      slide.appendChild(node)
      before.push({ el: node, style: node.getAttribute('style') || '', text: null, parent: null, next: null, present: false })
      after.push({ el: node, style: node.getAttribute('style') || '', text: null, parent: slide, next: node.nextSibling, present: true })
      newEls.push(node)
    })
    if (!newEls.length) return
    pushHistory(before, after, newEls)
    deselectAll()
    newEls.forEach(function (el) { el.classList.add('zt-selected') })
    selectedList = newEls.slice()
    postSelection()
    post({ type: 'changed' })
  }

  // ---- 文字编辑（双击进入）----
  function startTextEdit(el) {
    if (textEditing || !el) return
    textEditing = el
    var beforeText = el.textContent
    el.setAttribute('contenteditable', 'true')
    el.focus()
    var range = document.createRange()
    range.selectNodeContents(el)
    var sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)

    function finish() {
      el.removeAttribute('contenteditable')
      var afterText = el.textContent
      el.removeEventListener('blur', finish)
      document.removeEventListener('keydown', onKeyEdit, true)
      textEditing = null
      if (beforeText !== afterText) {
        var before = [{ el: el, style: el.getAttribute('style') || '', text: beforeText, parent: el.parentNode, next: el.nextSibling, present: true }]
        var after = [{ el: el, style: el.getAttribute('style') || '', text: afterText, parent: el.parentNode, next: el.nextSibling, present: true }]
        pushHistory(before, after, [el])
        post({ type: 'changed' })
      }
      postSelection()
    }
    function onKeyEdit(e) {
      if (e.key === 'Escape') {
        el.textContent = beforeText
        e.preventDefault()
        el.blur()
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        el.blur()
      }
    }
    el.addEventListener('blur', finish)
    document.addEventListener('keydown', onKeyEdit, true)
  }

  // ---- 重置选中元素的内联样式 ----
  function resetSelected() {
    if (!selectedList.length) return
    var before = selectedList.map(snapStyle)
    selectedList.forEach(function (el) { el.removeAttribute('style') })
    var after = selectedList.map(snapStyle)
    pushHistory(before, after, selectedList.slice())
    postSelection()
    post({ type: 'changed' })
  }

  // ---- 解除约束：清除选中元素的 max-/min- 宽高限制 ----
  function removeConstraints() {
    if (!selectedList.length) return
    var before = selectedList.map(snapStyle)
    selectedList.forEach(function (el) {
      el.style.removeProperty('max-width')
      el.style.removeProperty('max-height')
      el.style.removeProperty('min-width')
      el.style.removeProperty('min-height')
    })
    var after = selectedList.map(snapStyle)
    pushHistory(before, after, selectedList.slice())
    postSelection()
    post({ type: 'changed' })
  }

  // ---- 序列化（供草稿保存，保留编辑器样式/选择类，由父窗口剥离）----
  function serialize() {
    post({ type: 'serialize', html: document.documentElement.outerHTML, current: current })
  }

  function setGrid(on) {
    gridOn = !!on
    document.body.style.setProperty('--zt-grid-size', GRID_SIZE + 'px')
    if (gridOn) document.body.classList.add('zt-grid')
    else document.body.classList.remove('zt-grid')
  }

  function onPointerDown(e) {
    if (textEditing) {
      if (e.target === textEditing) return // 在文字内选择光标，不触发拖动
      textEditing.blur() // 点其它地方：先提交文字编辑
    }
    var t = e.target
    if (t && t.isContentEditable) return // 文字编辑中，不触发拖动
    if (!isEditable(t)) {
      if (!e.ctrlKey) deselectAll()
      return
    }
    if (e.ctrlKey) {
      toggleSelect(t) // Ctrl+点击：加入/移出多选，不触发拖动
      e.preventDefault()
      return
    }
    if (!isSelected(t)) selectOnly(t) // 普通点击：单选（替换）
    startDrag(selectedList.slice(), e) // 拖已选中的某个元素 → 整体一起拖
  }

  function init() {
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('dblclick', function (e) {
      var t = e.target
      if (!isEditable(t)) return
      startTextEdit(t)
      e.preventDefault()
    })
    document.addEventListener('keydown', function (e) {
      if (textEditing) return
      var ctrl = e.ctrlKey || e.metaKey
      var k = e.key.toLowerCase()
      if (ctrl && !e.shiftKey && k === 'z') {
        undo()
        e.preventDefault()
      } else if (ctrl && ((e.shiftKey && k === 'z') || k === 'y')) {
        redo()
        e.preventDefault()
      } else if (ctrl && k === 'c') {
        copySelection()
        e.preventDefault()
      } else if (ctrl && k === 'v') {
        paste()
        e.preventDefault()
      } else if (!ctrl && (k === 'delete' || k === 'backspace')) {
        deleteSelected()
        e.preventDefault()
      } else if (!ctrl && selectedList.length >= 2) {
        var map = { l: 'L', c: 'C', r: 'R', t: 'T', m: 'M', b: 'B', h: 'H', v: 'V', e: 'E', w: 'W', q: 'Q' }
        if (map[k]) {
          align(map[k])
          e.preventDefault()
        }
      }
    })
    window.addEventListener('message', function (e) {
      var m = e.data || {}
      if (m.type === 'goto') show(m.index)
      else if (m.type === 'next') show(current + 1)
      else if (m.type === 'prev') show(current - 1)
      else if (m.type === 'toggleGrid') {
        GRID_SIZE = m.size || 20
        setGrid(m.on)
      } else if (m.type === 'requestExport') exportClean()
      else if (m.type === 'requestSerialize') serialize()
      else if (m.type === 'resetElement') resetSelected()
      else if (m.type === 'align') align(m.mode)
      else if (m.type === 'setStyles') setStyles(m.styles || {})
      else if (m.type === 'setAspectLock') aspectRatioLocked = !!m.locked
      else if (m.type === 'removeConstraints') removeConstraints()
      else if (m.type === 'setText') setText(m.text)
      else if (m.type === 'delete') deleteSelected()
      else if (m.type === 'copy') copySelection()
      else if (m.type === 'paste') paste()
      else if (m.type === 'undo') undo()
      else if (m.type === 'redo') redo()
    })
    slides = getSlides()
    if (slides.length) show(0)
    else post({ type: 'pages', total: 0, current: 0 })
    post({ type: 'ready' })
  }

  function exportClean() {
    var styleEl = document.getElementById('zt-editor-style')
    var scriptEl = document.getElementById('zt-editor-runtime')
    if (styleEl) styleEl.remove()
    if (scriptEl) scriptEl.remove()
    document.body.classList.remove('zt-grid')
    selectedList.forEach(function (el) {
      el.classList.remove('zt-selected')
    })
    // 恢复开场页：移除所有 .slide 的 active，只保留第一个 .slide（开场）的 active。
    // 否则导出后 active 停留在编辑时的当前页，与自动播放脚本初始 currentSlide=0 不一致，
    // 脚本的 updateSlide 在 time>=0 时因 currentSlide===target 而跳过切换，
    // 导致开场页 S0 永远不被激活、看似“消失”。重置后可正常从头放映。
    var allSlides = document.querySelectorAll('.slide')
    allSlides.forEach(function (s) { s.classList.remove('active') })
    if (allSlides.length) allSlides[0].classList.add('active')
    post({ type: 'export', html: document.documentElement.outerHTML })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
