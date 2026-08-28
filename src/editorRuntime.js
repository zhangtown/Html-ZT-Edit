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
  var guideOverlay = null // 智能参考线
  var boxSelectOverlay = null // 框选矩形
  var SNAP_DISTANCE = 6 // 智能参考线吸附阈值（px）
  var placementMode = false // 素材放置模式
  var placementData = null // { url, assetType }
  var bindingMode = null // 字幕绑定模式：{ subtitleIndex: number } | null
  // ---- 播放预览模式状态 ----
  var playMode = false
  var playRaf = null
  var playAudio = null
  var playSubtitles = [] // {startSec,endSec,text}
  var playSubIndex = -1
  var playBaseTime = 0 // 无音频时的基准时间（秒）
  var playStartStamp = 0 // 无音频时的起始 performance.now()
  var playAudioOk = false // 音频是否真正播放成功（被自动播放策略拦截时走计时器兜底）

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
    deselectAll()
    current = i
    post({ type: 'pages', total: slides.length, current: current })
    post({ type: 'layers', layers: getLayers(), current: current, total: slides.length })
  }

  // ---- 当前页图层列表（按 z-index 降序，顶层在前）----
  function getGlobalElements() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-zt-global]'))
  }

  function getLayerElements() {
    var slide = slides[current]
    if (!slide) return []
    var all = Array.prototype.slice.call(slide.querySelectorAll('*'))
    var inSlide = all.filter(isEditable)
    // 追加全局元素（fixed 定位，不受 slide 切换影响）
    var globals = getGlobalElements()
    return inSlide.concat(globals)
  }

  function sortByZIndex(els) {
    return els.slice().sort(function (a, b) {
      var za = parseInt(getComputedStyle(a).zIndex, 10) || 0
      var zb = parseInt(getComputedStyle(b).zIndex, 10) || 0
      return zb - za || els.indexOf(b) - els.indexOf(a)
    })
  }

  function getLayers() {
    var children = getLayerElements()
    var sorted = sortByZIndex(children)
    var subEls = getSubtitleElements()
    return sorted.map(function (el, i) {
      var cs = getComputedStyle(el)
      return {
        index: i,
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').substring(0, 30),
        locked: !!el.getAttribute('data-zt-lock'),
        hidden: el.style.display === 'none',
        zIndex: parseInt(cs.zIndex, 10) || 0,
        id: el.getAttribute('data-zt-id') || '',
        name: el.getAttribute('data-zt-name') || '',
        role: el.getAttribute('data-zt-role') || '',
        subIdx: el.getAttribute('data-zt-role') === 'subtitle' ? subEls.indexOf(el) : -1,
        global: el.getAttribute('data-zt-global') !== null,
        opacity: cs.opacity,
        width: parseFloat(cs.width) || 0,
        height: parseFloat(cs.height) || 0,
      }
    })
  }

  function getElByLayerIndex(idx) {
    var children = getLayerElements()
    var sorted = sortByZIndex(children)
    return sorted[idx] || null
  }

  function reorderLayers(fromIdx, toIdx) {
    var slide = slides[current]
    if (!slide || fromIdx === toIdx) return
    var el = getElByLayerIndex(fromIdx)
    var targetEl = getElByLayerIndex(toIdx)
    if (!el || !targetEl) return
    // 收集所有元素，按新顺序排列
    var children = getLayerElements()
    var sorted = sortByZIndex(children)
    // 从 sorted 中移除 el，再插入到目标位置
    var before = sorted.map(function(e){return snapStyle(e)})
    var idx = sorted.indexOf(el)
    if (idx >= 0) sorted.splice(idx, 1)
    var targetPos = sorted.indexOf(targetEl)
    var insert = (fromIdx < targetPos) ? targetPos + 1 : targetPos
    sorted.splice(insert, 0, el)
    // 根据新顺序重新设置 z-index（顶层 z-index 最大）
    // 只对当前页可见元素设置，避免影响其他页面
    for (var i = 0; i < sorted.length; i++) {
      if (sorted[i] !== el) {
        sorted[i].style.zIndex = (sorted.length - i) * 10
      }
    }
    el.style.zIndex = (sorted.length - sorted.indexOf(el)) * 10
    // 在 DOM 中移动 el 到目标位置（保持视觉顺序与 z-index 一致）
    if (fromIdx < targetPos) {
      slide.insertBefore(el, targetEl.nextSibling)
    } else {
      slide.insertBefore(el, targetEl)
    }
    var after = sorted.map(function(e){return snapStyle(e)})
    pushHistory(before, after, [el])
  }

  function toggleLayerVisibility(idx) {
    var el = getElByLayerIndex(idx)
    if (!el) return
    var before = snapStyle(el)
    if (el.style.display === 'none') {
      el.style.display = ''
    } else {
      el.style.display = 'none'
    }
    var after = snapStyle(el)
    pushHistory([before], [after], [el])
    postSelection()
    post({ type: 'changed' })
  }

  function toggleLayerLock(idx) {
    var el = getElByLayerIndex(idx)
    if (!el) return
    var before = snapStyle(el)
    if (el.getAttribute('data-zt-lock')) {
      el.removeAttribute('data-zt-lock')
    } else {
      el.setAttribute('data-zt-lock', '1')
    }
    var after = snapStyle(el)
    pushHistory([before], [after], [el])
    postSelection()
    post({ type: 'changed' })
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
      locked: !!(el.getAttribute && el.getAttribute('data-zt-lock')),
      group: (el.getAttribute && el.getAttribute('data-zt-group')) || '',
      border: cs.border,
      borderRadius: cs.borderRadius,
      boxShadow: cs.boxShadow,
      animScaleFrom: el.getAttribute('data-zt-anim-scale-from') || '',
      animScaleTo: el.getAttribute('data-zt-anim-scale-to') || '',
      animOpacityFrom: el.getAttribute('data-zt-anim-opacity-from') || '',
      animOpacityTo: el.getAttribute('data-zt-anim-opacity-to') || '',
      animDuration: el.getAttribute('data-zt-anim-duration') || '',
      animDelay: el.getAttribute('data-zt-anim-delay') || '',
      animEasing: el.getAttribute('data-zt-anim-easing') || '',
      animEffect: el.getAttribute('data-zt-anim-effect') || '',
      animReturn: el.getAttribute('data-zt-anim-return') || '',
      opacity: cs.opacity,
    }
  }

  function postSelection() {
    var primary = selectedList.length ? getInfo(selectedList[selectedList.length - 1]) : null
    post({ type: 'selection', count: selectedList.length, primary: primary })
    post({ type: 'layers', layers: getLayers(), current: current, total: slides.length })
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

  // ---- 智能参考线（类似 PPT / PS 的延长线吸附）----
  function ensureGuideOverlay() {
    if (guideOverlay) return
    guideOverlay = document.createElement('div')
    guideOverlay.id = 'zt-guide-overlay'
    guideOverlay.style.cssText =
      'position:fixed;top:0;left:0;width:100%;height:100%;' +
      'pointer-events:none;z-index:2147483646;'
    document.body.appendChild(guideOverlay)
  }

  function clearGuides() {
    if (guideOverlay) guideOverlay.innerHTML = ''
  }

  function clearBoxSelect() {
    if (boxSelectOverlay && boxSelectOverlay.parentNode) boxSelectOverlay.parentNode.removeChild(boxSelectOverlay)
    boxSelectOverlay = null
  }

  function startBoxSelect(e, mode) {
    var slide = slides[current]
    if (!slide) return
    var sx = e.clientX
    var sy = e.clientY
    if (boxSelectOverlay && boxSelectOverlay.parentNode) boxSelectOverlay.parentNode.removeChild(boxSelectOverlay)
    boxSelectOverlay = document.createElement('div')
    boxSelectOverlay.id = 'zt-box-select'
    boxSelectOverlay.style.cssText =
      'position:fixed;left:' + sx + 'px;top:' + sy + 'px;width:0;height:0;' +
      'border:1px solid #2563eb;background:rgba(37,99,235,.08);' +
      'pointer-events:none;z-index:2147483646;'
    document.body.appendChild(boxSelectOverlay)

    function move(ev) {
      var x = Math.min(sx, ev.clientX)
      var y = Math.min(sy, ev.clientY)
      var w = Math.abs(ev.clientX - sx)
      var h = Math.abs(ev.clientY - sy)
      boxSelectOverlay.style.left = x + 'px'
      boxSelectOverlay.style.top = y + 'px'
      boxSelectOverlay.style.width = w + 'px'
      boxSelectOverlay.style.height = h + 'px'
    }

    function up(ev) {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      var x = Math.min(sx, ev.clientX)
      var y = Math.min(sy, ev.clientY)
      var w = Math.abs(ev.clientX - sx)
      var h = Math.abs(ev.clientY - sy)
      var rect = { left: x, top: y, right: x + w, bottom: y + h }
      var matched = Array.prototype.slice.call(slide.querySelectorAll('*')).filter(function (el) {
        if (!isEditable(el)) return false
        var r = el.getBoundingClientRect()
        // 所有模式都要求完全落在框内
        return r.left >= rect.left && r.right <= rect.right && r.top >= rect.top && r.bottom <= rect.bottom
      })
      var selected = matched
      if (mode === 'container') {
        // 默认：只选完全落在框内的“非叶子容器”，并且只保留最外层容器
        selected = matched.filter(function (el) {
          if (!el.children.length) return false
          return !matched.some(function (other) {
            return other !== el && other.contains(el)
          })
        })
      }
      // mode === 'layout' 时直接选中全部（叶子+容器）
      clearBoxSelect()
      selectThese(selected)
      post({ type: 'changed' })
    }

    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
    e.preventDefault()
  }


  function showGuides(vx, hy) {
    ensureGuideOverlay()
    guideOverlay.innerHTML = ''
    if (vx != null) {
      var v = document.createElement('div')
      v.style.cssText =
        'position:absolute;top:0;left:' + vx + 'px;width:1px;height:100%;' +
        'background:#C41E24;pointer-events:none;'
      guideOverlay.appendChild(v)
    }
    if (hy != null) {
      var h = document.createElement('div')
      h.style.cssText =
        'position:absolute;left:0;top:' + hy + 'px;width:100%;height:1px;' +
        'background:#C41E24;pointer-events:none;'
      guideOverlay.appendChild(h)
    }
  }

  function getReferenceEls(slide) {
    var all = Array.prototype.slice.call(slide.querySelectorAll('*'))
    return all.filter(function (el) {
      if (!isEditable(el)) return false
      if (selectedList.indexOf(el) >= 0) return false
      var r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })
  }

  function findSnapDelta(rect, refs, axis) {
    var myVals = axis === 'x'
      ? [rect.left, rect.left + rect.width / 2, rect.right]
      : [rect.top, rect.top + rect.height / 2, rect.bottom]
    var found = null
    refs.forEach(function (ref) {
      var r = ref.getBoundingClientRect()
      var refVals = axis === 'x'
        ? [r.left, r.left + r.width / 2, r.right]
        : [r.top, r.top + r.height / 2, r.bottom]
      myVals.forEach(function (mv) {
        refVals.forEach(function (rv) {
          var delta = rv - mv
          var dist = Math.abs(delta)
          if (dist <= SNAP_DISTANCE && (!found || dist < found.dist)) {
            found = { delta: delta, value: rv, dist: dist }
          }
        })
      })
    })
    return found
  }

  // 拖拽缩放：所有选中元素同步改变相同的宽高增量
  function startResize(dir, primary, e) {
    var els = selectedList.slice()
    if (els.length < 1) return
    if (isLocked(primary)) return
    var refs = getReferenceEls(slides[current])
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

    function applySizes(w, h) {
      var dw = w - startW
      var dh = h - startH
      els.forEach(function (el, i) {
        var tw = init[i].w + dw
        var th = init[i].h + dh
        if (tw < 8) tw = 8
        if (th < 8) th = 8
        el.style.width = tw + 'px'
        el.style.height = th + 'px'
        el.style.setProperty('max-width', 'none', 'important')
        el.style.setProperty('max-height', 'none', 'important')
      })
    }

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
        if (Math.abs(dx) > Math.abs(dy)) {
          newH = newW / ratio
        } else {
          newW = newH * ratio
        }
      }
      if (newW < 8) newW = 8
      if (newH < 8) newH = 8

      applySizes(newW, newH)
      // 缩放时也提供智能参考线
      var pr = primary.getBoundingClientRect()
      var snapX = findSnapDelta(pr, refs, 'x')
      var snapY = findSnapDelta(pr, refs, 'y')
      if (snapX) {
        if (dir.indexOf('e') >= 0) newW += snapX.delta
        else if (dir.indexOf('w') >= 0) newW -= snapX.delta
        if (newW < 8) newW = 8
      }
      if (snapY) {
        if (dir.indexOf('s') >= 0) newH += snapY.delta
        else if (dir.indexOf('n') >= 0) newH -= snapY.delta
        if (newH < 8) newH = 8
      }
      if (snapX || snapY) applySizes(newW, newH)
      showGuides(snapX ? snapX.value : null, snapY ? snapY.value : null)
      positionResizeHandles(primary)
    }

    function up() {
      clearGuides()
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

  // ---- 素材放置模式 ----
  function startPlacementMode(url, assetType) {
    placementMode = true
    placementData = { url: url, type: assetType }
    document.body.style.cursor = 'crosshair'
  }

  function exitPlacementMode() {
    placementMode = false
    placementData = null
    document.body.style.cursor = ''
    post({ type: 'placementCancelled' })
  }

  function createAssetElement(url, assetType) {
    var el
    if (assetType === 'video') {
      el = document.createElement('video')
      el.controls = true
    } else {
      el = document.createElement('img')
    }
    el.src = url
    // 图片和视频均添加倒角+阴影
    el.style.borderRadius = '12px'
    el.style.boxShadow = '0 4px 20px rgba(0,0,0,0.15)'
    el.style.maxWidth = '100%'
    el.style.maxHeight = '80vh'
    el.style.display = 'block'
    el.style.objectFit = 'contain'
    el.style.flex = '0 1 auto'
    el.style.margin = '8px auto'
    // 使用相对定位，插入到原有布局流中，随页面分辨率缩放
    el.style.position = 'relative'
    return el
  }

  // 找到点击/拖放位置所在的内容布局容器（优先 flex/grid 容器），兜底用 slide
  function findLayoutContainer(slide, target) {
    var el = target && target.nodeType === 1 ? target : null
    var fallback = null
    while (el && el !== document.body && el !== slide && el.parentElement) {
      var cs = getComputedStyle(el)
      var isFlexOrGrid = el !== slide && (cs.display === 'flex' || cs.display === 'grid' || cs.display === 'inline-flex' || cs.display === 'inline-grid')
      if (isFlexOrGrid) {
        var isRow = (cs.display === 'flex' || cs.display === 'inline-flex')
          ? cs.flexDirection === 'row' || cs.flexDirection === 'row-reverse'
          : true
        if (isRow) return el
        if (!fallback) fallback = el
      }
      el = el.parentElement
    }
    return fallback || slide
  }

  // 在容器内找到插入参考点：尽量插在命中元素后面
  function findInsertRef(container, target) {
    if (container === target) return null
    var child = target
    while (child && child.parentElement !== container) child = child.parentElement
    return child ? child.nextSibling : null
  }

  // 找离插入点最近的已有图片/视频（用于把它和新图放到同一个最小容器里）
  function findClosestImage(slide, x, y) {
    var all = Array.prototype.slice.call(slide.querySelectorAll('img, video')).filter(function (el) {
      return isEditable(el) && el.getBoundingClientRect().width > 0
    })
    if (!all.length) return null
    var best = null
    var bestDist = Infinity
    all.forEach(function (el) {
      var r = el.getBoundingClientRect()
      var dist = Math.sqrt(Math.pow(r.left + r.width / 2 - x, 2) + Math.pow(r.top + r.height / 2 - y, 2))
      if (dist < bestDist) { bestDist = dist; best = el }
    })
    return best
  }

  function makeHorizontalImageContainer(container) {
    if (!container) return
    var cs = getComputedStyle(container)
    if (cs.display === 'flex' || cs.display === 'inline-flex') {
      container.style.flexDirection = 'row'
      container.style.alignItems = 'center'
    } else {
      container.style.display = 'flex'
      container.style.flexDirection = 'row'
      container.style.alignItems = 'center'
      container.style.gap = (cs.gap && cs.gap !== 'normal' ? cs.gap : '12px')
    }
  }

  // 插入到布局流后，用相对定位的百分比偏移把元素移动到点击/拖放点附近
  function insertIntoLayout(container, el, ref, desiredX, desiredY, center) {
    container.insertBefore(el, ref)
    // 默认让图片/视频所在的布局变成左右结构
    if (el.tagName === 'IMG' || el.tagName === 'VIDEO') {
      makeHorizontalImageContainer(container)
    }
    var cRect = container.getBoundingClientRect()
    var eRect = el.getBoundingClientRect()
    var wantX = desiredX - (center ? eRect.width / 2 : 0)
    var wantY = desiredY - (center ? eRect.height / 2 : 0)
    var dx = wantX - (eRect.left - cRect.left)
    var dy = wantY - (eRect.top - cRect.top)
    if (cRect.width > 0) el.style.left = (dx / cRect.width * 100) + '%'
    else el.style.left = dx + 'px'
    if (cRect.height > 0) el.style.top = (dy / cRect.height * 100) + '%'
    else el.style.top = dy + 'px'
    // 相对定位，不脱离文档流，百分比会随布局尺寸缩放
    el.style.position = 'relative'
  }

  function placeAsset(e) {
    var slide = slides[current]
    if (!slide) { exitPlacementMode(); return }
    var el = createAssetElement(placementData.url, placementData.type)
    var target = e.target
    var existingImg = findClosestImage(slide, e.clientX, e.clientY)
    var container
    var ref
    if (existingImg) {
      container = existingImg.parentElement || slide
      makeHorizontalImageContainer(container)
      ref = existingImg.nextSibling
    } else {
      container = findLayoutContainer(slide, target)
      ref = findInsertRef(container, target)
    }
    var cRect = container.getBoundingClientRect()
    insertIntoLayout(container, el, ref, e.clientX - cRect.left, e.clientY - cRect.top, true)
    deselectAll()
    selectOnly(el)
    var before = [{ el: el, style: '', text: null, parent: null, next: null, present: false }]
    var after = [{ el: el, style: el.getAttribute('style') || '', text: null, parent: el.parentNode, next: el.nextSibling, present: true }]
    pushHistory(before, after, [el])
    placementMode = false
    placementData = null
    document.body.style.cursor = ''
    post({ type: 'changed' })
    post({ type: 'assetPlaced' })
  }

  // 拖拽素材到画布（从素材面板拖入，或文件拖入）
  var assetDragActive = false // 面板拖拽进行中
  var fileDropPending = [] // 暂存拖入的文件（等待父窗口响应）

  function insertAssetAt(url, assetType, x, y) {
    var slide = slides[current]
    if (!slide) return
    var el = createAssetElement(url, assetType)
    var sr = slide.getBoundingClientRect()
    var clientX = sr.left + x
    var clientY = sr.top + y
    var target = document.elementFromPoint(clientX, clientY)
    var existingImg = findClosestImage(slide, clientX, clientY)
    var container
    var ref
    if (existingImg) {
      container = existingImg.parentElement || slide
      makeHorizontalImageContainer(container)
      ref = existingImg.nextSibling
    } else {
      container = findLayoutContainer(slide, target)
      ref = findInsertRef(container, target)
    }
    var cRect = container.getBoundingClientRect()
    insertIntoLayout(container, el, ref, clientX - cRect.left, clientY - cRect.top, true)
    deselectAll()
    selectOnly(el)
    var before = [{ el: el, style: '', text: null, parent: null, next: null, present: false }]
    var after = [{ el: el, style: el.getAttribute('style') || '', text: null, parent: el.parentNode, next: el.nextSibling, present: true }]
    pushHistory(before, after, [el])
    post({ type: 'changed' })
    post({ type: 'assetPlaced' })
  }

  // 处理文件拖入画布（从系统文件管理器拖入）
  function handleFileDrop(e) {
    var files = e.dataTransfer.files
    if (!files || !files.length) return false
    var slide = slides[current]
    if (!slide) return false
    var slideRect = slide.getBoundingClientRect()
    var baseX = e.clientX - slideRect.left
    var baseY = e.clientY - slideRect.top
    if (baseX < 0) baseX = 0
    if (baseY < 0) baseY = 0
    var exts = /\.(png|jpg|jpeg|gif|webp|bmp|svg|mp4|webm|ogg|mov|avi)$/i
    var reader = new FileReader()
    var idx = 0
    function readNext() {
      while (idx < files.length) {
        var f = files[idx]
        idx++
        if (!exts.test(f.name)) continue
        var isVideo = /\.(mp4|webm|ogg|mov|avi)$/i.test(f.name)
        ;(function (file, posX, posY) {
          var r = new FileReader()
          r.onload = function () {
            // 发送 dataUrl 给父窗口，由父窗口创建 blob URL 并插入
            post({
              type: 'fileDropped',
              name: file.name,
              size: file.size,
              dataUrl: r.result,
              assetType: isVideo ? 'video' : 'image',
              x: posX,
              y: posY,
            })
          }
          r.readAsDataURL(file)
        })(f, baseX + (idx - 1) * 30, baseY + (idx - 1) * 30)
      }
    }
    readNext()
    return true
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
    clearGuides()
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
    // 全局元素（data-zt-global）不需要 .slide 容器
    if (t.getAttribute && t.getAttribute('data-zt-global') !== null) return true
    return !!t.closest('.slide')
  }

  // ---- 锁定 / 组合 / 层级 / 键盘微调 ----
  function isLocked(el) {
    return !!(el && el.getAttribute && el.getAttribute('data-zt-lock'))
  }

  function setLocked(locked) {
    if (!selectedList.length) return
    var before = selectedList.map(snapStyle)
    selectedList.forEach(function (el) {
      if (locked) el.setAttribute('data-zt-lock', '1')
      else el.removeAttribute('data-zt-lock')
    })
    var after = selectedList.map(snapStyle)
    pushHistory(before, after, selectedList.slice())
    postSelection()
    post({ type: 'changed' })
  }

  function groupSelected() {
    if (selectedList.length < 2) return
    var gid = 'zt-group-' + Date.now()
    var before = selectedList.map(snapStyle)
    selectedList.forEach(function (el) {
      el.setAttribute('data-zt-group', gid)
    })
    var after = selectedList.map(snapStyle)
    pushHistory(before, after, selectedList.slice())
    postSelection()
    post({ type: 'changed' })
  }

  function ungroupSelected() {
    if (!selectedList.length) return
    var gids = {}
    selectedList.forEach(function (el) {
      var g = el.getAttribute('data-zt-group')
      if (g) gids[g] = true
    })
    var affected = []
    var slide = slides[current]
    for (var gid in gids) {
      slide.querySelectorAll('[data-zt-group="' + gid + '"]').forEach(function (el) {
        if (affected.indexOf(el) < 0) affected.push(el)
      })
    }
    if (!affected.length) return
    var before = affected.map(snapStyle)
    affected.forEach(function (el) { el.removeAttribute('data-zt-group') })
    var after = affected.map(snapStyle)
    pushHistory(before, after, selectedList.slice())
    postSelection()
    post({ type: 'changed' })
  }

  function selectGroup(el) {
    var gid = el.getAttribute && el.getAttribute('data-zt-group')
    if (!gid) return selectOnly(el)
    var groupEls = Array.prototype.slice.call(slides[current].querySelectorAll('[data-zt-group="' + gid + '"]'))
      .filter(function (x) { return x.parentNode && isEditable(x) })
    if (!groupEls.length) return selectOnly(el)
    selectedList.forEach(function (x) { x.classList.remove('zt-selected') })
    selectedList = groupEls
    selectedList.forEach(function (x) { x.classList.add('zt-selected') })
    postSelection()
  }

  function toggleGroup(el) {
    var gid = el.getAttribute && el.getAttribute('data-zt-group')
    if (!gid) return toggleSelect(el)
    var groupEls = Array.prototype.slice.call(slides[current].querySelectorAll('[data-zt-group="' + gid + '"]'))
    var allSelected = groupEls.every(function (x) { return selectedList.indexOf(x) >= 0 })
    if (allSelected) {
      groupEls.forEach(function (x) {
        var i = selectedList.indexOf(x)
        if (i >= 0) selectedList.splice(i, 1)
        x.classList.remove('zt-selected')
      })
    } else {
      groupEls.forEach(function (x) {
        if (selectedList.indexOf(x) < 0) {
          selectedList.push(x)
          x.classList.add('zt-selected')
        }
      })
    }
    postSelection()
  }

  function layer(mode) {
    if (!selectedList.length) return
    var els = selectedList.slice()
    var before = els.map(snapStyle)
    els.forEach(function (el) {
      var parent = el.parentNode
      if (!parent) return
      if (mode === 'top') {
        parent.appendChild(el)
      } else if (mode === 'bottom') {
        parent.insertBefore(el, parent.firstChild)
      } else if (mode === 'up') {
        var next = el.nextElementSibling
        if (next) parent.insertBefore(el, next.nextSibling)
      } else if (mode === 'down') {
        var prev = el.previousElementSibling
        if (prev) parent.insertBefore(el, prev)
      }
    })
    var after = els.map(snapStyle)
    pushHistory(before, after, els.slice())
    postSelection()
    post({ type: 'changed' })
  }

  function moveSelectedBy(dx, dy) {
    if (!selectedList.length) return
    var before = selectedList.map(snapStyle)
    selectedList.forEach(function (el) { translateBy(el, dx, dy) })
    var after = selectedList.map(snapStyle)
    pushHistory(before, after, selectedList.slice())
    postSelection()
    post({ type: 'changed' })
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

  // ---- 拖动（支持整体多选拖动，带智能参考线吸附）----
  function startDrag(els, e) {
    var dragging = false
    var before = null
    var bases = null
    var refs = []
    var sx = e.clientX
    var sy = e.clientY

    function applyMove(gdx, gdy) {
      els.forEach(function (el, i) {
        var b = bases[i]
        var nx = b.e + gdx
        var ny = b.f + gdy
        el.style.transform =
          'matrix(' + b.a + ',' + b.b + ',' + b.c + ',' + b.d + ',' + nx + ',' + ny + ')'
      })
    }

    function move(ev) {
      var dx = ev.clientX - sx
      var dy = ev.clientY - sy
      if (!dragging) {
        if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return
        dragging = true
          // 拖动前取消预览动画，避免动画 transform 覆盖元素原本位置
          els.forEach(function (el) {
            if (el.getAnimations) el.getAnimations().forEach(function (a) { a.cancel() })
          })
        before = els.map(snapStyle)
        bases = els.map(function (el) {
          return safeMatrix(getComputedStyle(el).transform)
        })
        refs = getReferenceEls(slides[current])
      }
      var gdx = dx
      var gdy = dy
      if (gridOn) {
        // 以主元素为基准吸附网格，其他元素保持相对间距
        var gx = bases[0].e + gdx
        var gy = bases[0].f + gdy
        gdx = Math.round(gx / GRID_SIZE) * GRID_SIZE - bases[0].e
        gdy = Math.round(gy / GRID_SIZE) * GRID_SIZE - bases[0].f
      }
      applyMove(gdx, gdy)
      var primary = els[els.length - 1]
      var rect = primary.getBoundingClientRect()
      var snapX = findSnapDelta(rect, refs, 'x')
      var snapY = findSnapDelta(rect, refs, 'y')
      if (snapX) gdx += snapX.delta
      if (snapY) gdy += snapY.delta
      if (snapX || snapY) applyMove(gdx, gdy)
      showGuides(snapX ? snapX.value : null, snapY ? snapY.value : null)
    }

    function up() {
      clearGuides()
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
        } else if (k === 'border' || k === 'borderRadius' || k === 'boxShadow') {
          // 边框/圆角/阴影使用 important，避免页面 CSS 优先级更高导致不生效
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

  // ---- 动画设置 ----
  function setAnimation(props) {
    if (!selectedList.length) return
    var before = selectedList.map(snapStyle)
    var attrs = { animEffect:'data-zt-anim-effect', animDuration:'data-zt-anim-duration', animDelay:'data-zt-anim-delay', animReturn:'data-zt-anim-return', animEasing:'data-zt-anim-easing' }
    selectedList.forEach(function (el) {
      for (var k in props) {
        if (!props.hasOwnProperty(k)) continue
        var attr = attrs[k]
        if (!attr) continue
        var v = props[k]
        if (v === '' || v == null) el.removeAttribute(attr)
        else el.setAttribute(attr, v)
      }
    })
    var after = selectedList.map(snapStyle)
    pushHistory(before, after, selectedList.slice())
    postSelection()
    post({ type: 'changed' })
  }

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
      default: return { from: { transform: 'scale(1)' }, to: { transform: 'scale(1.2)' } }
    }
  }
  function previewAnim() {
    if (!selectedList.length) return
    selectedList.forEach(function (el) {
        if (!el.getAttribute('data-zt-anim-effect')) return // 没有动画效果：不预览
      var effect = el.getAttribute('data-zt-anim-effect') || 'zoom-in'
      // 聚焦强调类效果：通过 CSS 类切换实现（放大高亮 + 同组变暗），不用关键帧动画
      if (effect.indexOf('focus-') === 0) {
        var grp = el.closest('.focus-group')
        if (grp) grp.classList.add('dim-others')
        el.classList.add('zt-focus-active')
        setTimeout(function () {
          el.classList.remove('zt-focus-active')
          if (grp) grp.classList.remove('dim-others')
        }, 1200)
        return
      }
      var duration = parseFloat(el.getAttribute('data-zt-anim-duration')) || 1
      var delay = parseFloat(el.getAttribute('data-zt-anim-delay')) || 0
      var returnSec = parseFloat(el.getAttribute('data-zt-anim-return')) || 0
      var easing = el.getAttribute('data-zt-anim-easing') || 'ease'
      var kf = getEffectKeyframes(effect)
      var totalDur = duration + returnSec
        var baseTransform = el.style.transform || (getComputedStyle(el).transform && getComputedStyle(el).transform !== 'none' ? getComputedStyle(el).transform : '')
        if (baseTransform) baseTransform += ' '
      var keyframes = []
      if (delay > 0) keyframes.push({ offset: 0, transform: baseTransform + 'scale(1)', opacity: 1 })
      var startOff = delay > 0 ? delay / totalDur : 0
      var endOff = (delay + duration) / totalDur
      keyframes.push({ offset: startOff, transform: baseTransform + kf.from.transform, opacity: kf.from.opacity != null ? kf.from.opacity : 1 })
      keyframes.push({ offset: endOff, transform: baseTransform + kf.to.transform, opacity: kf.to.opacity != null ? kf.to.opacity : 1 })
      if (returnSec > 0) keyframes.push({ offset: 1, transform: baseTransform + 'scale(1)', opacity: 1 })
        if (el.getAnimations) el.getAnimations().forEach(function (a) { a.cancel() })
      el.animate(keyframes, { duration: totalDur * 1000, easing: easing, fill: 'none' })
    })
  }

  // ---- 字幕/时间轴功能 ----
  function getSubtitleElements() {
    var slide = slides[current]
    if (!slide) return []
    return Array.prototype.slice.call(slide.querySelectorAll('[data-zt-role="subtitle"]'))
      .filter(function (el) { return el.parentNode && isEditable(el) })
  }

  // 从页面脚本中读取全局 subtitles/slideTimings（由父窗口注入 window.__zt*）
  function getGlobalSubData() {
    var subs = window.__ztSubtitles
    var tms = window.__ztSlideTimings
    if (!subs || !tms || !subs.length || !tms.length) return null
    var timing = null
    for (var i = 0; i < tms.length; i++) {
      if (tms[i].slide === current) { timing = tms[i]; break }
    }
    if (!timing) return null
    var result = []
    var idx = 0
    for (var j = 0; j < subs.length; j++) {
      var s = subs[j]
      if (s.startSec >= timing.start && s.startSec < timing.end) {
        result.push({
          index: idx,
          text: (s.text || '').slice(0, 30),
          start: s.startSec - timing.start,
          end: (s.endSec || s.startSec + 3) - timing.start,
          boundTo: '',
          source: 'global',
          globalIndex: j,
        })
        idx++
      }
    }
    return result
  }

  function getSubtitlesData() {
    var els = getSubtitleElements()
    if (els.length) {
      return els.map(function (el, i) {
        return {
          index: i,
          text: el.textContent.slice(0, 30),
          start: parseFloat(el.getAttribute('data-zt-subtitle-start')) || 0,
          end: parseFloat(el.getAttribute('data-zt-subtitle-end')) || 5,
          boundTo: el.getAttribute('data-zt-bound-to') || '',
          source: 'dom',
        }
      })
    }
    // 回退：读取父窗口注入的字幕数据
    var globalData = getGlobalSubData()
    if (globalData && globalData.length) return globalData
    return []
  }

  function moveSubtitleToPage(direction, subtitleIndex) {
    var els = getSubtitleElements()
    if (els.length) {
      // DOM 字幕：移动元素到上/下一页
      var slide = slides[current]
      if (!slide) return
      if (subtitleIndex < 0 || subtitleIndex >= els.length) return
      var targetIndex = direction === 'prev' ? current - 1 : current + 1
      if (targetIndex < 0 || targetIndex >= slides.length) return
      var targetSlide = slides[targetIndex]
      var elsToMove = direction === 'prev'
        ? els.slice(0, subtitleIndex + 1) // 选中字幕 + 之前 → 到上一页
        : els.slice(subtitleIndex)         // 选中字幕 + 之后 → 到下一页
      if (!elsToMove.length) return
      var before = elsToMove.map(snapStyle)
      elsToMove.forEach(function (el) {
        slide.removeChild(el)
        targetSlide.appendChild(el)
      })
      var after = elsToMove.map(snapStyle)
      pushHistory(before, after, elsToMove.slice())
      deselectAll()
      postSelection()
      post({ type: 'changed' })
      post({ type: 'subtitlesMoved', subtitles: getSubtitlesData() })
      return
    }
    // 全局字幕：调整 slideTimings 边界
    var tms = window.__ztSlideTimings
    if (!tms) return
    var data = getSubtitlesData()
    var selected = data[subtitleIndex]
    if (!selected || selected.source !== 'global') return
    var curT = null, adjT = null
    for (var i = 0; i < tms.length; i++) {
      if (tms[i].slide === current) curT = tms[i]
      if (direction === 'prev' && tms[i].slide === current - 1) adjT = tms[i]
      if (direction === 'next' && tms[i].slide === current + 1) adjT = tms[i]
    }
    if (!curT || !adjT) return
    var absStart = curT.start + selected.start
    var absEnd = curT.start + selected.end
    if (direction === 'prev') {
      // 选中字幕 + 之前 → 上一页：边界设在选中字幕结束时间
      adjT.end = absEnd
      curT.start = absEnd
    } else {
      // 选中字幕 + 之后 → 下一页：边界设在选中字幕开始时间
      curT.end = absStart
      adjT.start = absStart
    }
    // 同步更新 <script> 标签文本（草稿保存 outerHTML 时保留修改）
    updateSlideTimingsInScript(tms)
    post({ type: 'changed' })
    post({ type: 'subtitlesMoved', subtitles: getSubtitlesData() })
  }

  function updateSlideTimingsInScript(tms) {
    // 直接更新 window 上的数据（供后续读取）
    window.__ztSlideTimings = tms
    // 同步更新注入的 <script> 标签文本（草稿保存 outerHTML 时保留修改）
    var scripts = document.querySelectorAll('script:not(#zt-editor-runtime)')
    for (var i = 0; i < scripts.length; i++) {
      var s = scripts[i]
      if (s.textContent && s.textContent.indexOf('__ztSlideTimings') >= 0) {
        s.textContent = 'window.__ztSubtitles=' + JSON.stringify(window.__ztSubtitles || []) +
          ';window.__ztSlideTimings=' + JSON.stringify(tms) + ';'
        return
      }
    }
  }

  function startBinding(subtitleIndex) {
    var els = getSubtitleElements()
    if (!els.length) {
      // 全局字幕不支持绑定（非 DOM 元素）
      post({ type: 'bindingNotSupported' })
      return
    }
    if (subtitleIndex < 0 || subtitleIndex >= els.length) return
    bindingMode = { subtitleIndex: subtitleIndex }
    document.body.style.cursor = 'crosshair'
    post({ type: 'bindingModeStarted' })
  }

  function cancelBinding() {
    document.querySelectorAll('.zt-binding-target').forEach(function (el) { el.classList.remove('zt-binding-target') })
    bindingMode = null
    document.body.style.cursor = ''
    post({ type: 'bindingCancelled' })
  }

  function confirmBinding() {
    if (!bindingMode) return
    var idx = bindingMode.subtitleIndex
    var subtitles = getSubtitleElements()
    var subtitleEl = subtitles[idx]
    var targetEl = document.querySelector('.zt-binding-target')
    if (!subtitleEl || !targetEl) { cancelBinding(); return }
    var targetId = targetEl.getAttribute('data-zt-id')
    if (!targetId) { cancelBinding(); return }
    var before = snapStyle(subtitleEl)
    subtitleEl.setAttribute('data-zt-bound-to', '[data-zt-id="' + targetId + '"]')
    var after = snapStyle(subtitleEl)
    pushHistory([before], [after], [subtitleEl])
    targetEl.classList.remove('zt-binding-target')
    bindingMode = null
    document.body.style.cursor = ''
    postSelection()
    post({ type: 'changed' })
    // 立即回传最新字幕数据，让时间轴立刻显示“已绑定”颜色，并能再次点击选中绑定元素
    post({ type: 'subtitles', subtitles: getSubtitlesData() })
    post({ type: 'bindingConfirmed', subtitleIndex: idx, targetSelector: '[data-zt-id="' + targetId + '"]' })
  }

  // 解除绑定：移除选中字幕的 data-zt-bound-to
  function unbindSubtitle(subtitleIndex) {
    var els = getSubtitleElements()
    var subtitleEl = els[subtitleIndex]
    if (!subtitleEl) return
    var before = snapStyle(subtitleEl)
    subtitleEl.removeAttribute('data-zt-bound-to')
    var after = snapStyle(subtitleEl)
    pushHistory([before], [after], [subtitleEl])
    post({ type: 'changed' })
    post({ type: 'subtitles', subtitles: getSubtitlesData() })
    post({ type: 'bindingUnbound', subtitleIndex: subtitleIndex })
  }

  // ---- 绑定关系呈现与联动 ----

  // 解除当前选中元素上的所有绑定
  function unbindSelectedElement() {
    var slide = slides[current]
    if (!slide || !selectedList.length) return
    var before = []
    var after = []
    var changed = false
    selectedList.forEach(function (el) {
      var id = el.getAttribute('data-zt-id')
      if (!id) return
      var selSubs = Array.prototype.slice.call(slide.querySelectorAll('[data-zt-role="subtitle"]'))
      selSubs.forEach(function (sub) {
        var bound = sub.getAttribute('data-zt-bound-to')
        if (bound && bound.indexOf('data-zt-id="' + id + '"') >= 0) {
          before.push(snapStyle(sub))
          sub.removeAttribute('data-zt-bound-to')
          after.push(snapStyle(sub))
          changed = true
        }
      })
    })
    if (!changed) return
    pushHistory(before, after, selectedList.slice())
    post({ type: 'changed' })
    post({ type: 'subtitles', subtitles: getSubtitlesData() })
    post({ type: 'bindingUnbound', subtitleIndex: -1 })
  }
  function clearBoundHighlight() {
    document.querySelectorAll('.zt-bound-highlight').forEach(function (el) { el.classList.remove('zt-bound-highlight') })
  }

  // 点击字幕时，选中它绑定的画面元素，便于直接修改动画/样式
  function selectBySelector(selector) {
    if (!selector) return
    var el = document.querySelector(selector)
    if (el && isEditable(el)) selectOnly(el)
  }

  // ---- 图片替换 ----
  function replaceSelectedImage(url) {
    if (!url || !selectedList.length) return
    var imgs = selectedList.filter(function (el) { return el.tagName === 'IMG' && !isLocked(el) })
    if (!imgs.length) return
    var before = imgs.map(snapStyle)
    imgs.forEach(function (el) { el.setAttribute('src', url) })
    var after = imgs.map(snapStyle)
    pushHistory(before, after, imgs.slice())
    postSelection()
    post({ type: 'changed' })
  }

  // ---- 元素删除 ----
  function deleteSelected() {
    selectedList = selectedList.filter(function (el) { return !isLocked(el) })
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

  function cutSelection() {
    if (!selectedList.length) return
    clipboard = selectedList.map(function (el) { return el.outerHTML })
    post({ type: 'clipboard', count: clipboard.length })
    deleteSelected()
  }

  function paste(m) {
    if (!clipboard.length) return
    var slide = slides[current]
    if (!slide) return
    // 支持鼠标坐标定位粘贴：m = { x, y }（iframe 内相对坐标）
    var hasPos = !!(m && typeof m.x === 'number' && typeof m.y === 'number')
    var sr = hasPos ? slide.getBoundingClientRect() : null
    var baseX = hasPos ? m.x - sr.left : 0
    var baseY = hasPos ? m.y - sr.top : 0
    var before = []
    var after = []
    var newEls = []
    clipboard.forEach(function (html, idx) {
      var tmp = document.createElement('div')
      tmp.innerHTML = html
      var node = tmp.firstElementChild
      if (!node) return
      slide.appendChild(node)
      // 定位粘贴：把元素 top-left 对齐到点击位置，多个元素逐行错开
      if (hasPos && node.style) {
        var cs = window.getComputedStyle(node)
        var wantX = baseX + idx * 24
        var wantY = baseY + idx * 24
        if (cs.position === 'relative') {
          var er = node.getBoundingClientRect()
          node.style.left = (wantX - (er.left - sr.left)) + 'px'
          node.style.top = (wantY - (er.top - sr.top)) + 'px'
        } else {
          node.style.position = 'absolute'
          node.style.left = wantX + 'px'
          node.style.top = wantY + 'px'
          // 若 slide 使用百分比定位体系，换算百分比
          if (sr.width && cs.left.indexOf('%') >= 0) node.style.left = (wantX / sr.width * 100) + '%'
          if (sr.height && cs.top.indexOf('%') >= 0) node.style.top = (wantY / sr.height * 100) + '%'
        }
      }
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
  function startTextEditOnSubtitle(subIdx) {
    var subEls = getSubtitleElements()
    var el = subEls[subIdx]
    if (!el || textEditing) return
    var hiddenChain = []
    var check = el
    while (check && check !== document.body) {
      if (getComputedStyle(check).display === 'none') {
        hiddenChain.push({ el: check, oldDisplay: check.style.display || '' })
        check.style.display = 'block'
      }
      check = check.parentElement
    }
    startTextEdit(el)
    if (textEditing) {
      el._ztHiddenChain = hiddenChain
    } else {
      for (var i = 0; i < hiddenChain.length; i++) {
        hiddenChain[i].el.style.display = hiddenChain[i].oldDisplay || 'none'
      }
    }
  }

  function startTextEditOnLayer(idx) {
    var el = getElByLayerIndex(idx)
    if (!el || textEditing) return
    // 如果元素（或祖先）被隐藏，临时显示以便编辑
    var hiddenChain = []
    var check = el
    while (check && check !== document.body) {
      if (getComputedStyle(check).display === 'none') {
        hiddenChain.push({ el: check, oldDisplay: check.style.display || '' })
        check.style.display = 'block'
      }
      check = check.parentElement
    }
    // 劫持原有 finish 逻辑，在完成后恢复隐藏
    var origFinish = null
    startTextEdit(el)
    // 如果 startTextEdit 成功设置 textEditing，在其 blur 事件前插入恢复逻辑
    if (textEditing) {
      // 用 mutation observer 或包装 blur 事件
      // 简单方式：在 el 上挂一个标记，由 finish 检查
      el._ztHiddenChain = hiddenChain
    } else {
      // startTextEdit 失败（可能 textEditing 已被占用），恢复隐藏
      for (var i = 0; i < hiddenChain.length; i++) {
        hiddenChain[i].el.style.display = hiddenChain[i].oldDisplay || 'none'
      }
    }
  }

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
      // 恢复隐藏的祖先（字幕等）
      if (el._ztHiddenChain) {
        for (var hc = 0; hc < el._ztHiddenChain.length; hc++) {
          el._ztHiddenChain[hc].el.style.display = el._ztHiddenChain[hc].oldDisplay || 'none'
        }
        delete el._ztHiddenChain
      }
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
    selectedList.forEach(function (el) {
      var orig = el.getAttribute('data-zt-original-style')
      if (orig !== null) {
        el.setAttribute('style', orig)
      } else {
        el.removeAttribute('style')
      }
      // 清理属性面板可能添加的字体标记与 CSS 变量
      el.removeAttribute('data-zt-ff')
      el.removeAttribute('data-zt-fs')
      el.removeAttribute('data-zt-fw')
      el.style.removeProperty('--zt-ff')
      el.style.removeProperty('--zt-fs')
      el.style.removeProperty('--zt-fw')
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
    // 画布任意左键点击都通知父层关闭右键菜单
    post({ type: 'canvasPointerDown' })
    if (playMode) return // 播放模式下禁用编辑交互
    // 放置模式：点击画布即插入素材
    // 绑定模式：点击元素即选中目标，高亮显示，等待父窗口确认
    if (bindingMode) {
      var t = e.target
        var bindTargetEl = t && t.closest ? (t.closest('[data-zt-id]') || t.closest('.focus-item') || t) : t
        if (bindTargetEl) t = bindTargetEl
      if (isEditable(t) && !isLocked(t)) {
        // 清除之前的高亮
        document.querySelectorAll('.zt-binding-target').forEach(function(el) { el.classList.remove('zt-binding-target') })
        t.classList.add('zt-binding-target')
        // 给目标元素生成唯一标识
        var targetId = t.getAttribute('data-zt-id')
        if (!targetId) {
          targetId = 'zt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
          t.setAttribute('data-zt-id', targetId)
        }
        post({ type: 'bindingTarget', selector: '[data-zt-id="' + targetId + '"]', tag: t.tagName, text: t.textContent })
      }
      e.preventDefault()
      return
    }
    if (placementMode) {
      placeAsset(e)
      return
    }
    if (textEditing) {
      if (e.target === textEditing) return // 在文字内选择光标，不触发拖动
      textEditing.blur() // 点其它地方：先提交文字编辑
    }
    var t = e.target
    if (t && t.isContentEditable) return // 文字编辑中，不触发拖动
    var multi = e.ctrlKey || e.metaKey
    if (!isEditable(t)) {
      // 框选三模式：
      // 默认：完全包含 + 只选叶子元素
      // Shift/Ctrl：完全包含 + 连布局容器一起选
      // Alt：碰到就选（只选叶子元素，避免半截句子不选）
      var boxMode = 'container'
      if (e.shiftKey || e.ctrlKey || e.metaKey) boxMode = 'layout'
      startBoxSelect(e, boxMode)
      return
    }
    if (multi) {
      if (t.getAttribute && t.getAttribute('data-zt-group')) toggleGroup(t)
      else toggleSelect(t) // Ctrl/Cmd+点击：加入/移出多选，不触发拖动
      e.preventDefault()
      return
    }
    var insideSelected = selectedList.some(function (el) { return el !== t && el.contains(t) })
    if (!isSelected(t) && !insideSelected) {
      if (t.getAttribute && t.getAttribute('data-zt-group')) selectGroup(t)
      else selectOnly(t)
    }
    if (!isLocked(t)) startDrag(selectedList.slice(), e) // 拖已选中的某个元素或其内部 → 整体一起拖
  }

  function onContextMenu(e) {
    e.preventDefault()
    if (playMode) return // 播放模式下不弹右键菜单
    var t = e.target
    // 可编辑元素或已锁定元素都选中（锁定元素需要解锁入口）
    if (isEditable(t)) {
      if (!isSelected(t)) {
        if (t.getAttribute && t.getAttribute('data-zt-group')) selectGroup(t)
        else selectOnly(t)
      }
    } else {
      // 画布空白处右键：清除选中，便于对空白执行/多选外操作
      deselectAll()
    }
    var primary = selectedList.length ? selectedList[selectedList.length - 1] : null
    post({
      type: 'contextmenu',
      x: e.clientX,
      y: e.clientY,
      editable: selectedList.length > 0,
      count: selectedList.length,
      locked: !!primary,
      primaryLocked: !!(primary && primary.locked),
      primaryGroup: (primary && primary.group) || '',
      anyLocked: selectedList.some(isLocked),
    })
  }

  // ==================== 播放预览模式 ====================
  // 复用导出播放脚本的逻辑：音频驱动时间轴，到点切页/上字幕/触发绑定动画。
  // 进入播放模式不改动文档结构，停止后回到编辑模式，状态完全可逆。

  function getPlayAudio() {
    return document.getElementById('bgAudio') || document.querySelector('audio')
  }

  function getPlayTimings() {
    return window.__ztSlideTimings || []
  }

  function playTimingFor(slideIdx) {
    var tms = getPlayTimings()
    for (var i = 0; i < tms.length; i++) {
      if (tms[i].slide === slideIdx) return tms[i]
    }
    return null
  }

  function buildPlaySubtitles() {
    var subs = []
    var slidesArr = getSlides()
    var hasDom = false
    slidesArr.forEach(function (sl, si) {
      var st = playTimingFor(si)
      sl.querySelectorAll('[data-zt-role="subtitle"]').forEach(function (el) {
        hasDom = true
        var rStart = parseFloat(el.getAttribute('data-zt-subtitle-start')) || 0
        var rEnd = parseFloat(el.getAttribute('data-zt-subtitle-end')) || 0
        subs.push({ startSec: (st ? st.start : 0) + rStart, endSec: (st ? st.start : 0) + rEnd, text: el.textContent })
      })
    })
    if (!hasDom && window.__ztSubtitles && window.__ztSubtitles.length) {
      subs = window.__ztSubtitles.map(function (s) {
        return { startSec: s.startSec, endSec: s.endSec, text: s.text }
      })
    }
    return subs
  }

  // 清理绑定动画/聚焦的播放痕迹（跳页、停止、重播时调用）
  function resetPlayAnimState() {
    document.querySelectorAll('[data-zt-bound-to]').forEach(function (sub) {
      var sel = sub.getAttribute('data-zt-bound-to')
      if (!sel) return
      var el = document.querySelector(sel)
      if (!el) return
      delete el.dataset.animDone
      delete el.dataset.focusDone
      el.classList.remove('zt-focus-active')
      var g = el.closest('.focus-group')
      if (g) g.classList.remove('dim-others')
    })
    if (document.getAnimations) {
      document.getAnimations().forEach(function (a) { a.cancel() })
    }
  }

  // 可靠 seek：元数据未就绪时等 loadedmetadata 后再设置，否则赋值会被丢弃
  function seekAudioTo(sec) {
    if (!playAudio) return
    function doSeek() { try { playAudio.currentTime = sec } catch (e) {} }
    if (playAudio.readyState >= 1) doSeek()
    else {
      playAudio.addEventListener('loadedmetadata', doSeek, { once: true })
      // 兜底：1.5s 后若仍未就绪直接尝试
      setTimeout(function () { if (playAudio && playAudio.readyState >= 1) doSeek() }, 1500)
    }
  }

  function playShowSlide(idx, seek) {
    slides = getSlides()
    if (!slides.length) return
    if (idx < 0) idx = 0
    if (idx > slides.length - 1) idx = slides.length - 1
    slides.forEach(function (s, i) {
      s.classList.remove('active')
      if (i === idx) s.classList.add('active')
    })
    current = idx
    resetPlayAnimState()
    if (seek) {
      var st = playTimingFor(idx)
      if (st) {
        seekAudioTo(st.start)
        playBaseTime = st.start
        playStartStamp = performance.now()
      }
    }
    post({ type: 'playProgress', current: idx, total: slides.length })
  }

  function playCurrentTime() {
    if (playAudio && playAudioOk) return playAudio.currentTime
    return playBaseTime + (performance.now() - playStartStamp) / 1000
  }

  function playUpdateSubtitle(t) {
    var subtitleEl = document.getElementById('subtitleCurrent')
    if (!subtitleEl) return
    var ns = -1
    for (var i = 0; i < playSubtitles.length; i++) {
      if (t >= playSubtitles[i].startSec && t < playSubtitles[i].endSec) { ns = i; break }
    }
    if (ns !== playSubIndex && ns !== -1) {
      subtitleEl.classList.add('is-changing')
      ;(function (text) {
        setTimeout(function () {
          subtitleEl.textContent = text
          subtitleEl.classList.remove('is-changing')
        }, 350)
      })(playSubtitles[ns].text)
      playSubIndex = ns
    }
  }

  function playUpdateSlide(t) {
    var tms = getPlayTimings()
    for (var i = tms.length - 1; i >= 0; i--) {
      if (t >= tms[i].start) {
        if (current !== tms[i].slide) playShowSlide(tms[i].slide, false)
        break
      }
    }
  }

  function playTriggerBoundAnims(t) {
    var cur = document.querySelector('.slide.active')
    if (!cur) return
    cur.querySelectorAll('[data-zt-role="subtitle"]').forEach(function (subEl) {
      var boundSel = subEl.getAttribute('data-zt-bound-to')
      if (!boundSel) return
      var boundEl = document.querySelector(boundSel)
      if (!boundEl) return
      var effect = boundEl.getAttribute('data-zt-anim-effect') || ''
      var subStart = parseFloat(subEl.getAttribute('data-zt-subtitle-start'))
      var st = playTimingFor(current)
      var absStart = (subStart || 0) + (st ? st.start : 0)
      if (effect.indexOf('focus-') === 0) {
        if (boundEl.dataset.focusDone) return
        if (t >= absStart) {
          boundEl.dataset.focusDone = '1'
          var grp = boundEl.closest('.focus-group')
          if (grp) grp.classList.add('dim-others')
          boundEl.classList.add('zt-focus-active')
        }
      } else {
        if (boundEl.dataset.animDone) return
        if (t >= absStart && t < absStart + 0.5) {
          boundEl.dataset.animDone = '1'
          var grp2 = boundEl.closest('.focus-group')
          if (grp2) { grp2.classList.remove('dim-others'); boundEl.classList.remove('zt-focus-active') }
          playBoundAnimation(boundEl, effect)
        }
      }
    })
  }

  function playBoundAnimation(el, effect) {
    if (!el || !effect) return
    var kf = getEffectKeyframes(effect || 'zoom-in')
    var dur = parseFloat(el.getAttribute('data-zt-anim-duration')) || 1
    var dly = parseFloat(el.getAttribute('data-zt-anim-delay')) || 0
    var ret = parseFloat(el.getAttribute('data-zt-anim-return')) || 0
    var ease = el.getAttribute('data-zt-anim-easing') || 'ease'
    var totalDur = dur + ret
    var baseTransform = el.style.transform || (getComputedStyle(el).transform && getComputedStyle(el).transform !== 'none' ? getComputedStyle(el).transform : '')
    if (baseTransform) baseTransform += ' '
    var keyframes = []
    if (dly > 0) keyframes.push({ offset: 0, transform: baseTransform + 'scale(1)', opacity: 1 })
    var startOff = dly > 0 ? dly / totalDur : 0
    var endOff = (dly + dur) / totalDur
    keyframes.push({ offset: startOff, transform: baseTransform + kf.from.transform, opacity: kf.from.opacity != null ? kf.from.opacity : 1 })
    keyframes.push({ offset: endOff, transform: baseTransform + kf.to.transform, opacity: kf.to.opacity != null ? kf.to.opacity : 1 })
    if (ret > 0) keyframes.push({ offset: 1, transform: baseTransform + 'scale(1)', opacity: 1 })
    el.animate(keyframes, { duration: totalDur * 1000, easing: ease, fill: 'none' })
  }

  function playLoop() {
    if (!playMode) return
    var t = playCurrentTime()
    playUpdateSlide(t)
    playUpdateSubtitle(t)
    playTriggerBoundAnims(t)
    var progressBar = document.getElementById('progressBar')
    if (progressBar && playAudio && playAudio.duration) {
      progressBar.style.width = (t / playAudio.duration * 100) + '%'
    }
    playRaf = requestAnimationFrame(playLoop)
  }

  // ---- 原生播放（复用 HTML 自带的播放系统）----
  // 优先用 HTML 自带播放脚本驱动画面与语音，避免与编辑器引擎重复驱动导致冲突。
  var nativeMode = false
  var nativeRaf = null
  var nativeScriptEl = null

  function injectNativePlayer(code) {
    if (nativeScriptEl) return
    // 去掉原生脚本里绑在 document/window 上的交互监听（前进/后退由编辑器 UI 负责），
    // 仅保留播放引擎本身，并把 startPlayback 暴露为全局以便外部启动；同时支持外部停止残留循环。
    code = code
      .replace(/window\.addEventListener\('load'[\s\S]*?\}\);/, 'window.__ztStartPlayback=function(){if(window.__ztKillNative)return;startPlayback();};window.__ztNativeStop=function(){isPlaying=false;};window.__ztSeekToSlide=function(idx){var st=slideTimings.find(function(t){return t.slide===idx});if(st)audio.currentTime=st.start;showSlide(idx,false);var sl=slides[idx];if(sl){var ns=sl.querySelectorAll("*");for(var k2=0;k2<ns.length;k2++){var cs=getComputedStyle(ns[k2]);if(cs.animationName&&cs.animationName!=="none"){ns[k2].style.animation="none";void ns[k2].offsetWidth;ns[k2].style.animation="";}}}};')
      .replace(/document\.addEventListener\('keydown'[\s\S]*?\}\);/, '')
      .replace(/document\.addEventListener\('click'[\s\S]*?\}\);/, '')
    var s = document.createElement('script')
    s.textContent = code
    document.body.appendChild(s)
    nativeScriptEl = s
  }

  function killNativePlayer() {
    if (nativeScriptEl && nativeScriptEl.parentNode) {
      try { nativeScriptEl.parentNode.removeChild(nativeScriptEl) } catch (e) {}
    }
    nativeScriptEl = null
    window.__ztNativeInjected = false
    window.__ztKillNative = false
  }

  function nativeTick() {
    if (!nativeMode) return
    var slides = document.querySelectorAll('.slide')
    var idx = -1
    for (var i = 0; i < slides.length; i++) {
      if (slides[i].classList.contains('active')) { idx = i; break }
    }
    if (idx >= 0) post({ type: 'playProgress', current: idx })
    nativeRaf = requestAnimationFrame(nativeTick)
  }

  function startPlay(fromIndex, nativeScript) {
    if (playMode) stopPlay(true)
    slides = getSlides()
    if (!slides.length) return
    // 退出可能进行中的编辑交互
    if (textEditing) { try { textEditing.blur() } catch (e) {} }
    if (placementMode) exitPlacementMode()
    if (bindingMode) cancelBinding()
    deselectAll()
    clearBoxSelect()
    if (resizeOverlay && resizeOverlay.parentNode) resizeOverlay.parentNode.removeChild(resizeOverlay)
    resizeOverlay = null
    resizeHandles = {}
    document.body.classList.remove('zt-grid')
    // 解除编辑态的动画冻结（*{animation:none;transition:none}），让 CSS 动画/focus 过渡在播放时生效
    var editorStyle = document.getElementById('zt-editor-style')
    if (editorStyle && editorStyle.sheet) editorStyle.sheet.disabled = true
    playMode = true

    // 优先使用 HTML 自带的原生播放系统（避免与编辑器引擎重复驱动导致冲突）
    var hasAudio = getPlayAudio() && getPlayAudio().getAttribute('src')
    if (nativeScript && hasAudio) {
      nativeMode = true
      injectNativePlayer(nativeScript)
      window.__ztKillNative = false
      var startIdx = (typeof fromIndex === 'number' && fromIndex > 0) ? fromIndex : 0
      // 原生播放器错过了 load 自动启动，这里显式启动（暴露的 startPlayback）
      setTimeout(function () {
        if (!nativeMode) return
        if (window.__ztStartPlayback) {
          window.__ztStartPlayback()
          // 跳到目标页并把音频定位到该页起点（含首页：重新播放开场动画/音频；停止后再播放也不会继承进度）
          if (window.__ztSeekToSlide) window.__ztSeekToSlide(startIdx)
        } else {
          document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        }
      }, 60)
      nativeRaf = requestAnimationFrame(nativeTick)
      post({ type: 'playState', playing: true, current: startIdx })
      return
    }

    // 回退：编辑器自有引擎（无原生播放器的普通 .slide 页面）
    playSubtitles = buildPlaySubtitles()
    playSubIndex = -1
    playAudio = getPlayAudio()
    playAudioOk = false
    if (fromIndex == null || fromIndex < 0) fromIndex = 0
    if (fromIndex > slides.length - 1) fromIndex = slides.length - 1
    var st = playTimingFor(fromIndex)
    playBaseTime = st ? st.start : 0
    playStartStamp = performance.now()
    playShowSlide(fromIndex, false)
    if (playAudio) {
      seekAudioTo(  playBaseTime)
      try {
        var p = playAudio.play()
        if (p && p.then) {
          p.then(function () {
            if (!playMode) return
            playAudioOk = true
          }).catch(function () { playAudioOk = false })
        } else {
          playAudioOk = true
        }
      } catch (e) { playAudioOk = false }
      // 音频自然播完 → 自动停止并返回编辑模式
      playAudio.onended = function () { stopPlay() }
    }
    post({ type: 'playState', playing: true, current: current })
    playRaf = requestAnimationFrame(playLoop)
  }

  function stopPlay(silent) {
    if (playRaf) { cancelAnimationFrame(playRaf); playRaf = null }
    if (nativeRaf) { cancelAnimationFrame(nativeRaf); nativeRaf = null }
    nativeMode = false
    window.__ztKillNative = true
    // 停止原生播放循环：置 isPlaying=false，让原生 loop 自行退出（移除 script 无法停掉已排程的 rAF）
    try { if (window.__ztNativeStop) window.__ztNativeStop() } catch (e) {}
    // 暂停底层音频（原生播放器与编辑器引擎共用同一 <audio>）
    var a = getPlayAudio()
    if (a) { try { a.pause() } catch (e) {} }
    // 记录原生播放最后停留的页，停后让编辑器当前页与之对齐
    var lastIdx = current
    var sls = document.querySelectorAll('.slide')
    for (var i = 0; i < sls.length; i++) { if (sls[i].classList.contains('active')) { lastIdx = i; break } }
    killNativePlayer()
    if (playAudio) {
      try { playAudio.pause() } catch (e) {}
      playAudio.onended =  null
    }
    current = lastIdx
    playMode = false
    // 恢复编辑态动画冻结
    var editorStyle2 = document.getElementById('zt-editor-style')
    if (editorStyle2 && editorStyle2.sheet) editorStyle2.sheet.disabled = false
    playSubIndex = -1
    resetPlayAnimState()
    if (!silent) post({ type: 'playState', playing: false, current: lastIdx })
  }

  function playGoto(idx) {
    if (!playMode) { show(idx); return }
    playSubIndex = -1
    playShowSlide(idx, true)
  }

  function init() {
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('contextmenu', onContextMenu)
    document.addEventListener('dblclick', function (e) {
      if (playMode) return
      var t = e.target
      if (!isEditable(t) || isLocked(t)) return
      startTextEdit(t)
      e.preventDefault()
    })
    document.addEventListener('keydown', function (e) {
      // 放置模式按 Esc 取消
      if (placementMode && e.key === 'Escape') {
        exitPlacementMode()
        e.preventDefault()
        return
      }
      if (textEditing) return
      if (playMode) {
        // 播放模式仅放行 Esc（停止播放，返回编辑模式）
        if (e.key === 'Escape') { stopPlay(); e.preventDefault() }
        return
      }
      var ctrl = e.ctrlKey || e.metaKey
      var k = e.key.toLowerCase()
      if (ctrl && !e.shiftKey && k === 'z') {
        undo()
        e.preventDefault()
      } else if (ctrl && ((e.shiftKey && k === 'z') || k === 'y')) {
        redo()
        e.preventDefault()
      } else if (ctrl && k === 'x') {
        cutSelection()
        e.preventDefault()
      } else if (ctrl && k === 'c') {
        copySelection()
        e.preventDefault()
      } else if (ctrl && k === 'v') {
        paste()
        e.preventDefault()
      } else if (!ctrl && ['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].indexOf(k) >= 0) {
        var step = e.shiftKey ? 10 : 1
        var dx = k === 'arrowleft' ? -step : (k === 'arrowright' ? step : 0)
        var dy = k === 'arrowup' ? -step : (k === 'arrowdown' ? step : 0)
        if (dx || dy) moveSelectedBy(dx, dy)
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
    // Ctrl+滚轮：画布缩放（50% ~ 150%，10% 步进），由父窗口处理
    document.addEventListener('wheel', function (e) {
      if (e.ctrlKey) {
        e.preventDefault()
        post({ type: 'zoom', deltaY: e.deltaY })
      }
    }, { passive: false })
    // 拖拽放置素材 / 文件
    document.addEventListener('dragover', function (e) { e.preventDefault() })
    document.addEventListener('drop', function (e) {
      e.preventDefault()
      // 系统文件拖入（从文件管理器）
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        if (handleFileDrop(e)) return
      }
      // 素材面板拖入：获取坐标，通知父窗口
      if (assetDragActive) {
        var slide = slides[current]
        if (slide) {
          var sr = slide.getBoundingClientRect()
          post({ type: 'assetDropPosition', x: e.clientX - sr.left, y: e.clientY - sr.top })
        }
        assetDragActive = false
      }
    })
    window.addEventListener('message', function (e) {
      var m = e.data || {}
      if (m.type === 'goto') show(m.index)
      else if (m.type === 'next') show(current + 1)
      else if (m.type === 'prev') show(current - 1)
      else if (m.type === 'startPlay') startPlay(m.from, m.nativeScript)
      else if (m.type === 'stopPlay') stopPlay()
      else if (m.type === 'playGoto') playGoto(m.index)
      else if (m.type === 'toggleGrid') {
        GRID_SIZE = m.size || 20
        setGrid(m.on)
      } else if (m.type === 'requestExport') exportClean()
      else if (m.type === 'requestSerialize') serialize()
      else if (m.type === 'resetElement') resetSelected()
      else if (m.type === 'align') align(m.mode)
      else if (m.type === 'layer') layer(m.mode)
      else if (m.type === 'group') groupSelected()
      else if (m.type === 'ungroup') ungroupSelected()
      else if (m.type === 'toggleLock') setLocked(!isLocked(selectedList[selectedList.length - 1]))
      else if (m.type === 'moveBy') moveSelectedBy(m.dx, m.dy)
      else if (m.type === 'replaceImage') replaceSelectedImage(m.url)
      else if (m.type === 'setStyles') setStyles(m.styles || {})
      else if (m.type === 'setAspectLock') aspectRatioLocked = !!m.locked
      else if (m.type === 'enterPlacementMode') startPlacementMode(m.url, m.assetType)
      else if (m.type === 'exitPlacementMode') exitPlacementMode()
      else if (m.type === 'insertAsset') insertAssetAt(m.url, m.assetType, m.x, m.y)
      else if (m.type === 'assetDragStarted') assetDragActive = true
      else if (m.type === 'assetDragEnded') assetDragActive = false
      else if (m.type === 'setText') setText(m.text)
      else if (m.type === 'setAnimation') setAnimation(m.props || {})
      else if (m.type === 'previewAnim') previewAnim()
      else if (m.type === 'requestSubtitles') post({ type: 'subtitles', subtitles: getSubtitlesData() })
      else if (m.type === 'selectLayer') { var el = getElByLayerIndex(m.index); if (el) selectOnly(el) }
      else if (m.type === 'startTextEdit') { startTextEditOnLayer(m.index) }
      else if (m.type === 'startTextEditOnSubtitle') { startTextEditOnSubtitle(m.subIdx) }
      else if (m.type === 'reorderLayers') { reorderLayers(m.fromIdx, m.toIdx); post({ type: 'layers', layers: getLayers(), current: current, total: slides.length }) }
      else if (m.type === 'requestLayers') post({ type: 'layers', layers: getLayers(), current: current, total: slides.length })
      else if (m.type === 'selectBound') selectBySelector(m.selector)
      else if (m.type === 'clearBoundHighlight') clearBoundHighlight()
      else if (m.type === 'moveSubtitle') moveSubtitleToPage(m.direction, m.subtitleIndex)
      else if (m.type === 'startBinding') startBinding(m.subtitleIndex)
      else if (m.type === 'cancelBinding') cancelBinding()
      else if (m.type === 'confirmBinding') confirmBinding()
        else if (m.type === 'unbindSubtitle') unbindSubtitle(m.subtitleIndex)
        else if (m.type === 'unbindSelectedElement') unbindSelectedElement()
      else if (m.type === 'toggleLayerVisibility') { toggleLayerVisibility(m.index) }
      else if (m.type === 'toggleLayerLock') { toggleLayerLock(m.index) }
      else if (m.type === 'delete') deleteSelected()
      else if (m.type === 'copy') copySelection()
      else if (m.type === 'cut') cutSelection()
      else if (m.type === 'paste') paste(m)
      else if (m.type === 'undo') undo()
      else if (m.type === 'redo') redo()
    })
    slides = getSlides()
    if (slides.length) show(0)
    else post({ type: 'pages', total: 0, current: 0 })
    post({ type: 'ready' })

    // 保存所有元素的原始内联样式，供"重置选中"恢复使用
    document.querySelectorAll('*').forEach(function (el) {
      var s = el.getAttribute('style')
      if (s !== null) {
        el.setAttribute('data-zt-original-style', s)
      }
    })
  }

  function exportClean() {
    var styleEl = document.getElementById('zt-editor-style')
    var scriptEl = document.getElementById('zt-editor-runtime')
    var fontEl = document.getElementById('zt-editor-fonts')
    if (styleEl) styleEl.remove()
    if (scriptEl) scriptEl.remove()
    if (fontEl) fontEl.remove()
    if (resizeOverlay && resizeOverlay.parentNode) resizeOverlay.parentNode.removeChild(resizeOverlay)
    resizeOverlay = null
    resizeHandles = {}
    if (guideOverlay && guideOverlay.parentNode) guideOverlay.parentNode.removeChild(guideOverlay)
    guideOverlay = null
    clearBoxSelect()
    document.body.classList.remove('zt-grid')
    selectedList.forEach(function (el) {
      el.classList.remove('zt-selected')
    })
    // 清理编辑器临时的聚焦/绑定/选中状态，避免导出后元素像蒙了一层遮罩
    document.querySelectorAll('.zt-selected, .zt-focus-active, .zt-bound-highlight, .zt-bound-mark, .zt-binding-target')
      .forEach(function (el) {
        el.classList.remove('zt-selected', 'zt-focus-active', 'zt-bound-highlight', 'zt-bound-mark', 'zt-binding-target')
      })
    document.querySelectorAll('.focus-group.dim-others').forEach(function (el) {
      el.classList.remove('dim-others')
    })
    // 清除正在播放的预览动画，避免影响导出后页面状态
    if (document.getAnimations) {
      document.getAnimations().forEach(function (a) { a.cancel() })
    }
    // 恢复开场页：移除所有 .slide 的 active，只保留第一个 .slide（开场）的 active。
    // 否则导出后 active 停留在编辑时的当前页，与自动播放脚本初始 currentSlide=0 不一致，
    // 脚本的 updateSlide 在 time>=0 时因 currentSlide===target 而跳过切换，
    // 导致开场页 S0 永远不被激活、看似“消失”。重置后可正常从头放映。
    var allSlides = document.querySelectorAll('.slide')
    allSlides.forEach(function (s) { s.classList.remove('active') })
    if (allSlides.length) allSlides[0].classList.add('active')
    // 清理编辑器内部使用的 data 属性，避免污染导出 HTML
    document.querySelectorAll('[data-zt-original-style], [data-zt-ff], [data-zt-fs], [data-zt-fw]').forEach(function (el) {
      el.removeAttribute('data-zt-original-style')
      el.removeAttribute('data-zt-ff')
      el.removeAttribute('data-zt-fs')
      el.removeAttribute('data-zt-fw')
    })
    post({ type: 'export', html: document.documentElement.outerHTML })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
