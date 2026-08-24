import React, { useEffect, useRef, useState } from 'react'
import editorRuntimeSrc from './editorRuntime.js?raw'
import {
  pickFolder,
  buildFileMap,
  listHtmlFiles,
  dirOf,
} from './loadFolder.js'
import { stripScripts, rewriteAssets, restoreAndWrap, stripEditorParts } from './htmlProcess.js'
import { saveDraft, loadDraft, clearDraft } from './draftStore.js'

// 注入 iframe 的编辑器样式（选中轮廓 + 网格 + 编辑态冻结动画）
const STYLE_TAG =
  '<style id="zt-editor-style">' +
  '*{animation:none!important;transition:none!important;}' + // 编辑态冻结 CSS 动画/过渡，避免播放干扰拖拽；导出/草稿时随之移除
  '.zt-selected{outline:2px solid #C41E24!important;outline-offset:1px;}' +
  'body.zt-grid::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:2147483647;' +
  'background-image:linear-gradient(to right,rgba(0,0,0,.08) 1px,transparent 1px),' +
  'linear-gradient(to bottom,rgba(0,0,0,.08) 1px,transparent 1px);' +
  'background-size:var(--zt-grid-size,20px) var(--zt-grid-size,20px);}' +
  '</style>'

const SCRIPT_TAG = '<script id="zt-editor-runtime">' + editorRuntimeSrc + '<\/script>'

// 对齐/分布/等尺寸：标签 + 快捷键字母 + 模式（用于「对齐」Tab，带中文名）
const ALIGNS = [
  ['L', '左对齐'],
  ['C', '水平居中'],
  ['R', '右对齐'],
  ['T', '顶端对齐'],
  ['M', '垂直居中'],
  ['B', '底端对齐'],
  ['H', '横向分布'],
  ['V', '纵向分布'],
  ['E', '等高'],
  ['W', '等宽'],
  ['Q', '等尺寸'],
]

const FONTS = [
  ['', '（不修改）'],
  ['"Noto Serif SC", serif', '思源宋体'],
  ['"Noto Sans SC", sans-serif', '思源黑体'],
  ['"Microsoft YaHei", sans-serif', '微软雅黑'],
  ['"SimSun", serif', '宋体'],
  ['"KaiTi", serif', '楷体'],
  ['serif', '衬线 Serif'],
  ['sans-serif', '无衬线 Sans'],
  ['monospace', '等宽 Mono'],
]

const WEIGHTS = [
  ['', '（不修改）'],
  ['400', '常规'],
  ['700', '加粗'],
  ['300', '细'],
  ['900', '特粗'],
]

function download(filename, text) {
  const blob = new Blob([text], { type: 'text/html' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

export default function App() {
  const iframeRef = useRef(null)
  const fileMapRef = useRef(new Map())
  const relMapRef = useRef(new Map())
  const scriptsRef = useRef([])
  const gridOnRef = useRef(false)
  const pendingSaveRef = useRef(false)
  const saveTimerRef = useRef(null)
  const restoredRef = useRef(false)
  const pendingCurrentRef = useRef(0)
  const lastSavedRef = useRef(0)

  const [htmlFiles, setHtmlFiles] = useState([])
  const [activeHtml, setActiveHtml] = useState('')
  const [srcdoc, setSrcdoc] = useState('')
  const [ready, setReady] = useState(false)
  const [total, setTotal] = useState(0)
  const [current, setCurrent] = useState(0)
  const [gridOn, setGridOn] = useState(false)
  const [selected, setSelected] = useState(null)
  const [selCount, setSelCount] = useState(0)
  const [restored, setRestored] = useState(false)
  const [tab, setTab] = useState('prop') // prop | align | assets | info
  const [aspectLock, setAspectLock] = useState(false)
  const [assets, setAssets] = useState([]) // [{ name, url, type }] 素材列表
  const [placingAsset, setPlacingAsset] = useState(null) // { url, name, type } | null

  gridOnRef.current = gridOn

  function send(msg) {
    iframeRef.current?.contentWindow?.postMessage(msg, '*')
  }

  // ---------- 加载 / 恢复 ----------
  async function handlePick() {
    try {
      const files = await pickFolder()
      const map = buildFileMap(files)
      fileMapRef.current = map
      const list = listHtmlFiles(files)
      setHtmlFiles(list)
      if (list.length === 0) {
        alert('该文件夹下没有找到 HTML 文件')
        return
      }
      const target = list[0]
      setActiveHtml(target)
      await loadHtml(target, map)
    } catch (e) {
      if (e.message !== '已取消') alert('选择文件夹失败：' + e.message)
    }
  }

  async function loadHtml(relPath, map) {
    const fm = map || fileMapRef.current
    const file = fm.get(relPath)
    if (!file) return
    const text = await file.text()
    const { html: stripped, scripts } = stripScripts(text)
    const baseDir = dirOf(relPath)
    const relMap = new Map()
    const processed = rewriteAssets(stripped, baseDir, fm, relMap)
    scriptsRef.current = scripts
    relMapRef.current = relMap
    const doc = processed.replace('</body>', STYLE_TAG + SCRIPT_TAG + '</body>')
    setReady(false)
    setSelected(null)
    setRestored(false)
    restoredRef.current = false
    setSrcdoc(doc)
  }

  // 从本地草稿恢复（刷新后自动执行）
  async function restoreFromDraft(d) {
    const relMap = new Map()
    let html = d.html || ''
    for (const a of d.assets || []) {
      try {
        const url = URL.createObjectURL(a.blob)
        relMap.set(url, a.val)
        html = html.split(a.val).join(url)
      } catch (e) {}
    }
    scriptsRef.current = d.scripts || []
    relMapRef.current = relMap
    pendingCurrentRef.current = d.current || 0
    const doc = html.replace('</body>', STYLE_TAG + SCRIPT_TAG + '</body>')
    setReady(false)
    setSelected(null)
    restoredRef.current = true
    setRestored(true)
    setSrcdoc(doc)
  }

  // ---------- 自动保存草稿 ----------
  function scheduleSave() {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(performSave, 800)
  }

  function performSave() {
    pendingSaveRef.current = true
    send({ type: 'requestSerialize' })
  }

  async function actuallySave(html, pageCurrent) {
    try {
      let clean = stripEditorParts(html)
      // 资源：blob URL -> 原始相对引用，并收集 blob 存储
      const assets = []
      for (const [blobUrl, val] of relMapRef.current.entries()) {
        clean = clean.split(blobUrl).join(val)
        try {
          const blob = await (await fetch(blobUrl)).blob()
          assets.push({ val, blob })
        } catch (e) {}
      }
      await saveDraft({
        html: clean,
        assets,
        scripts: scriptsRef.current,
        current: pageCurrent,
        savedAt: Date.now(),
      })
      lastSavedRef.current = Date.now()
    } catch (e) {
      console.warn('草稿保存失败', e)
    }
  }

  async function handleClearDraft() {
    if (!confirm('确定清除本地草稿？此操作不可撤销（不影响你磁盘上的原文件）。')) return
    await clearDraft()
    setRestored(false)
    restoredRef.current = false
    alert('本地草稿已清除。')
  }

  // ---------- 导出 ----------
  function handleExport() {
    send({ type: 'requestExport' })
  }

  function toggleGrid() {
    const next = !gridOn
    setGridOn(next)
    send({ type: 'toggleGrid', on: next, size: 20 })
  }

  // ---------- 通信 ----------
  useEffect(() => {
    function onMessage(e) {
      const m = e.data || {}
      if (m.type === 'ready') {
        setReady(true)
        if (gridOnRef.current) send({ type: 'toggleGrid', on: true, size: 20 })
        if (pendingCurrentRef.current) {
          send({ type: 'goto', index: pendingCurrentRef.current })
          pendingCurrentRef.current = 0
        }
      } else if (m.type === 'pages') {
        setTotal(m.total)
        setCurrent(m.current)
      } else if (m.type === 'selection') {
        setSelCount(m.count)
        setSelected(m.primary)
      } else if (m.type === 'deselected') {
        setSelCount(0)
        setSelected(null)
      } else if (m.type === 'changed') {
        scheduleSave()
      } else if (m.type === 'serialize') {
        if (pendingSaveRef.current) {
          pendingSaveRef.current = false
          actuallySave(m.html, m.current)
        }
      } else if (m.type === 'export') {
        const finalHtml = restoreAndWrap(m.html, relMapRef.current, scriptsRef.current)
        download('edited.html', finalHtml)
      }
    }
    function onKey(e) {
      // 焦点在输入框 / 文本域 / 下拉框 / 可编辑元素内时，不拦截快捷键（否则属性面板无法正常输入）
      const t = e.target
      const tag = t && t.tagName
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        (t && t.isContentEditable === true)
      ) {
        return
      }
      const ctrl = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (ctrl && !e.shiftKey && k === 'z') {
        send({ type: 'undo' })
        e.preventDefault()
      } else if (ctrl && ((e.shiftKey && k === 'z') || k === 'y')) {
        send({ type: 'redo' })
        e.preventDefault()
      } else if (ctrl && k === 'c') {
        send({ type: 'copy' })
        e.preventDefault()
      } else if (ctrl && k === 'v') {
        send({ type: 'paste' })
        e.preventDefault()
      } else if (!ctrl && (k === 'delete' || k === 'backspace')) {
        // 避免误删（仅在画布聚焦且无输入框时）；交由 iframe 处理更稳妥，这里不拦截
      } else if (!ctrl && selCount >= 2) {
        const map = { l: 'L', c: 'C', r: 'R', t: 'T', m: 'M', b: 'B', h: 'H', v: 'V', e: 'E', w: 'W', q: 'Q' }
        if (map[k]) {
          send({ type: 'align', mode: map[k] })
          e.preventDefault()
        }
      }
    }
    window.addEventListener('message', onMessage)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('message', onMessage)
      window.removeEventListener('keydown', onKey)
    }
  }, [selCount])

  // 选择文件夹时，同步提取图片/视频素材
  const assetUrlsRef = useRef([])
  useEffect(() => {
    // 清理旧 blob URL
    assetUrlsRef.current.forEach((u) => URL.revokeObjectURL(u))
    assetUrlsRef.current = []
    const fm = fileMapRef.current
    if (!fm.size) { setAssets([]); return }
    const list = []
    const exts = /\.(png|jpg|jpeg|gif|webp|bmp|svg|mp4|webm|ogg|mov|avi)$/i
    for (const [path, file] of fm) {
      if (!exts.test(path)) continue
      const url = URL.createObjectURL(file)
      assetUrlsRef.current.push(url)
      const isVideo = /\.(mp4|webm|ogg|mov|avi)$/i.test(path)
      list.push({ name: path.split('/').pop() || path, url, type: isVideo ? 'video' : 'image' })
    }
    setAssets(list)
  }, [htmlFiles])

  // 拖拽素材到画布
  function handleDragStart(asset) {
    dragDataRef.current = asset
    send({ type: 'assetDragStarted' })
  }
  function handleDragEnd() {
    dragDataRef.current = null
    send({ type: 'assetDragEnded' })
  }

  // 放置素材到画布
  function handlePlaceAsset(asset) {
    setPlacingAsset(asset)
    send({ type: 'enterPlacementMode', url: asset.url, assetType: asset.type })
  }

  function cancelPlacement() {
    setPlacingAsset(null)
    send({ type: 'exitPlacementMode' })
  }

  // 素材放置完成/取消
  useEffect(() => {
    function onMessage(e) {
      const m = e.data || {}
      if (m.type === 'assetPlaced' || m.type === 'placementCancelled') {
        setPlacingAsset(null)
      }
      // 拖拽放置：iframe 告知坐标，我方回传素材信息
      if (m.type === 'assetDropPosition') {
        const d = dragDataRef.current
        if (d) {
          send({ type: 'insertAsset', url: d.url, assetType: d.type, x: m.x, y: m.y })
          dragDataRef.current = null
        }
      }
      // 文件拖入画布：iframe 传来 dataUrl，创建 blob URL 并插入
      if (m.type === 'fileDropped') {
        const blob = dataUrlToBlob(m.dataUrl)
        const url = URL.createObjectURL(blob)
        assetUrlsRef.current.push(url)
        send({ type: 'insertAsset', url, assetType: m.assetType, x: m.x, y: m.y })
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // 锁定纵横比变化时同步到 iframe
  useEffect(() => {
    send({ type: 'setAspectLock', locked: aspectLock })
  }, [aspectLock])

  // 首次挂载：尝试从草稿恢复
  useEffect(() => {
    ;(async () => {
      try {
        const d = await loadDraft()
        if (d && d.html) await restoreFromDraft(d)
      } catch (e) {}
    })()
    // eslint-disable-next-line
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          background: '#1f2937',
          color: '#fff',
          flexWrap: 'wrap',
        }}
      >
        <strong style={{ fontSize: 15 }}>HTML 可视化编辑器 · ZtEdit</strong>
        <button onClick={handlePick} style={btn('#C41E24')}>
          选择文件夹
        </button>
        {htmlFiles.length > 1 && (
          <select
            value={activeHtml}
            onChange={(e) => {
              setActiveHtml(e.target.value)
              loadHtml(e.target.value)
            }}
            style={{ ...btn('#374151'), minWidth: 200 }}
          >
            {htmlFiles.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}

        <span style={{ width: 1, height: 22, background: '#374151' }} />

        <button onClick={() => send({ type: 'prev' })} disabled={!ready} style={btn('#374151')}>
          ← 上一页
        </button>
        <span style={{ fontSize: 13, minWidth: 64, textAlign: 'center' }}>
          {total ? `${current + 1} / ${total}` : '— / —'}
        </span>
        <button onClick={() => send({ type: 'next' })} disabled={!ready} style={btn('#374151')}>
          下一页 →
        </button>

        <span style={{ width: 1, height: 22, background: '#374151' }} />

        <button onClick={toggleGrid} style={btn(gridOn ? '#0F6E56' : '#374151')}>
          {gridOn ? '网格：开' : '网格：关'}
        </button>
        <button
          onClick={() => send({ type: 'resetElement' })}
          disabled={!selected}
          style={btn('#374151')}
        >
          重置选中
        </button>
        <button onClick={() => send({ type: 'undo' })} disabled={!ready} title="撤销（Ctrl+Z）" style={btn('#374151')}>
          撤销
        </button>
        <button onClick={() => send({ type: 'redo' })} disabled={!ready} title="重做（Ctrl+Shift+Z）" style={btn('#374151')}>
          重做
        </button>
        <button onClick={() => send({ type: 'delete' })} disabled={!selected} title="删除选中（Delete）" style={btn('#7f1d1d')}>
          删除
        </button>
        <button onClick={handleExport} disabled={!ready} style={btn('#2563eb')}>
          导出 HTML
        </button>
        <button onClick={handleClearDraft} disabled={!restored} title="清除本地草稿" style={btn('#4b5563')}>
          清除草稿
        </button>

        <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 'auto' }}>
          📁 本地读取，文件不会上传到任何服务器
        </span>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, background: '#e5e7eb', position: 'relative' }}>
          {srcdoc ? (
            <iframe
              ref={iframeRef}
              title="canvas"
              srcDoc={srcdoc}
              sandbox="allow-scripts allow-same-origin allow-popups"
              style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
            />
          ) : (
            <div
              style={{
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#6b7280',
                fontSize: 15,
                padding: 24,
                textAlign: 'center',
              }}
            >
              点击左上角「选择文件夹」，选中包含 HTML 及其图片/视频的整个文件夹开始编辑。
              <br />
              <br />
              若之前编辑过且未清除草稿，刷新后会自动从本机恢复。
            </div>
          )}
        </div>

        <div
          style={{
            width: 270,
            background: '#fff',
            borderLeft: '1px solid #e5e7eb',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb' }}>
            {[
              ['prop', '属性'],
              ['align', '对齐'],
              ['assets', '素材'],
              ['info', '信息'],
            ].map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                style={{
                  flex: 1,
                  padding: '10px 0',
                  border: 'none',
                  background: tab === k ? '#C41E24' : '#f3f4f6',
                  color: tab === k ? '#fff' : '#374151',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <div style={{ padding: 14, overflow: 'auto', flex: 1 }}>
            {!selected && (
              <p style={{ color: '#9ca3af', fontSize: 13, lineHeight: 1.7 }}>
                在画布中点击任意元素（图片 / 卡片 / 文字 / 字幕等）即可选中并拖动。
                <br />
                <br />
                按住 <b>Ctrl</b> 点击可多选，选中后整体拖动或用「对齐」页排版。
                <br />
                <br />
                <b>双击</b>文字元素可直接修改文字内容。
                <br />
                <br />
                所有改动会自动存为本地草稿，刷新不丢失。
              </p>
            )}

            {selected && tab === 'prop' && (
              <PropPanel selected={selected} send={send} selCount={selCount} aspectLock={aspectLock} setAspectLock={setAspectLock} />
            )}

            {selected && tab === 'align' && (
              <div>
                <p style={{ fontSize: 13, color: '#C41E24', fontWeight: 600, margin: '0 0 10px' }}>
                  已选中 {selCount} 个元素（需 ≥2）
                </p>
                <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 10px' }}>
                  对齐以所选元素为整体；分布需 ≥3 个元素。
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {ALIGNS.map(([mode, label]) => (
                    <button
                      key={mode}
                      onClick={() => send({ type: 'align', mode })}
                      disabled={selCount < 2}
                      title={label + '（' + mode + '）'}
                      style={{
                        ...btn(selCount < 2 ? '#d1d5db' : '#374151'),
                        fontSize: 12,
                        padding: '9px 6px',
                        textAlign: 'left',
                      }}
                    >
                      {label}（{mode}）
                    </button>
                  ))}
                </div>
                <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 12, lineHeight: 1.6 }}>
                  也可用快捷键：L/C/R/T/M/B/H/V/E/W/Q。
                  <br />
                  分布（H/V）与对齐同样支持撤销（Ctrl+Z）。
                </p>
              </div>
            )}

            {selected && tab === 'info' && (
              <div style={{ fontSize: 13, lineHeight: 1.9 }}>
                <p style={{ margin: '0 0 8px', color: '#C41E24', fontWeight: 600 }}>
                  已选中 {selCount} 个元素
                </p>
                <Row k="标签" v={selected.tag} />
                <Row k="class" v={selected.cls || '—'} />
                <Row k="id" v={selected.id || '—'} />
                <Row k="定位" v={selected.position || '—'} />
                <Row k="transform" v={selected.transform || '—'} />
                <Row k="宽" v={selected.width || '—'} />
                <Row k="高" v={selected.height || '—'} />
                <Row k="字号" v={selected.fontSize || '—'} />
                <Row k="字重" v={selected.fontWeight || '—'} />
                <Row k="文字色" v={selected.color || '—'} />
                <Row k="背景色" v={selected.backgroundColor || '—'} />
              </div>
            )}
            {tab === 'assets' && (
              <AssetsPanel
                assets={assets}
                placingAsset={placingAsset}
                onPlace={handlePlaceAsset}
                onCancel={cancelPlacement}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// 属性面板（大小 / 颜色 / 字体 / 文本），随选中元素同步回显
function PropPanel({ selected, send, selCount, aspectLock, setAspectLock }) {
  const [width, setWidth] = useState('')
  const [height, setHeight] = useState('')
  const [color, setColor] = useState('')
  const [bg, setBg] = useState('')
  const [font, setFont] = useState('')
  const [size, setSize] = useState('')
  const [weight, setWeight] = useState('')
  const [text, setText] = useState('')

  // 选中变化时，用计算样式回填（让用户看到当前值）
  useEffect(() => {
    setWidth(stripPx(selected.width))
    setHeight(stripPx(selected.height))
    setColor(toHex(selected.color))
    setBg(toHex(selected.backgroundColor))
    setFont(selected.fontFamily || '')
    setSize(stripPx(selected.fontSize))
    setWeight(selected.fontWeight === '400' || selected.fontWeight === 'normal' ? '400' : selected.fontWeight)
    setText(selected.text || '')
  }, [selected])

  // 统一应用样式：直接传入值，不使用 if(v) 过滤（解决 falsy 值被跳过的问题）
  // 空字符串表示不修改该属性，空对象表示不发送
  function apply(over) {
    const styles = {}
    const w = over && over.width !== undefined ? over.width : width
    const h = over && over.height !== undefined ? over.height : height
    const c = over && over.color !== undefined ? over.color : color
    const b = over && over.bg !== undefined ? over.bg : bg
    const f = over && over.font !== undefined ? over.font : font
    const s = over && over.size !== undefined ? over.size : size
    const wt = over && over.weight !== undefined ? over.weight : weight
    // 只有非空字符串才加入（空字符串 = 不修改）
    if (w !== '') styles.width = w + (isNum(w) ? 'px' : '')
    if (h !== '') styles.height = h + (isNum(h) ? 'px' : '')
    if (c !== '') styles.color = c
    if (b !== '') styles.backgroundColor = b
    if (f !== '') styles.fontFamily = f
    if (s !== '') styles.fontSize = s + (isNum(s) ? 'px' : '')
    if (wt !== '') styles.fontWeight = wt
    if (Object.keys(styles).length) send({ type: 'setStyles', styles })
  }

  // 回车立即应用并移出焦点（属性面板的单行输入框回车即保存）
  function enterApply(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      apply()
      e.currentTarget.blur()
    }
  }

  return (
    <div style={{ fontSize: 13 }}>
      <p style={{ color: '#C41E24', fontWeight: 600, margin: '0 0 10px' }}>
        已选中 {selCount} 个元素
      </p>

      <Field label="宽度">
        <input style={inp} value={width} onChange={(e) => { setWidth(e.target.value); if (aspectLock && e.target.value) { const r = getAspectRatio(selected); if (r) setHeight(String(Math.round(parseFloat(e.target.value) / r))); } }} onBlur={apply} onKeyDown={enterApply} placeholder="如 200 或 50%" />
      </Field>
      <Field label="高度">
        <input style={inp} value={height} onChange={(e) => { setHeight(e.target.value); if (aspectLock && e.target.value) { const r = getAspectRatio(selected); if (r) setWidth(String(Math.round(parseFloat(e.target.value) * r))); } }} onBlur={apply} onKeyDown={enterApply} placeholder="如 100 或 auto" />
      </Field>
      <Field label="锁定纵横比">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, color: '#374151' }}>
          <input type="checkbox" checked={aspectLock} onChange={(e) => setAspectLock(e.target.checked)} />
          宽高联动（改宽自动算高，改高自动算宽）
        </label>
      </Field>
      <Field label="文字颜色">
        <input type="color" style={{ ...inp, padding: 2, height: 30 }} value={color || '#000000'} onChange={(e) => { setColor(e.target.value); apply({ color: e.target.value }) }} />
      </Field>
      <Field label="背景颜色">
        <input type="color" style={{ ...inp, padding: 2, height: 30 }} value={bg || '#000000'} onChange={(e) => { setBg(e.target.value); apply({ bg: e.target.value }) }} />
      </Field>
      <Field label="字体">
        <select style={inp} value={font} onChange={(e) => { const v = e.target.value; setFont(v); apply({ font: v }) }}>
          {FONTS.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </Field>
      <Field label="字号">
        <input style={inp} value={size} onChange={(e) => setSize(e.target.value)} onBlur={apply} onKeyDown={enterApply} placeholder="如 16 或 1.2em" />
      </Field>
      <Field label="字重">
        <select style={inp} value={weight} onChange={(e) => { const v = e.target.value; setWeight(v); apply({ weight: v }) }}>
          {WEIGHTS.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </Field>

      <div style={{ marginTop: 8, marginBottom: 4, color: '#6b7280' }}>文本内容（双击画布也可直接改）</div>
      <textarea
        style={{ ...inp, height: 60, resize: 'vertical' }}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => send({ type: 'setText', text })}
        onKeyDown={(e) => {
          // 多行文本：Ctrl+Enter 提交，普通 Enter 换行
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            send({ type: 'setText', text })
          }
        }}
      />

      <button
        onClick={() => send({ type: 'delete' })}
        style={{ ...btn('#7f1d1d'), width: '100%', marginTop: 12 }}
      >
        删除选中元素（Delete）
      </button>

      <p style={{ color: '#9ca3af', fontSize: 12, marginTop: 12, lineHeight: 1.6 }}>
        拖动即平移（保留旋转/缩放）；Ctrl+Z 撤销、Ctrl+Shift+Z 重做。
        <br />
        复制 Ctrl+C / 粘贴 Ctrl+V（可跨页）。
      </p>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ color: '#6b7280', marginBottom: 3 }}>{label}</div>
      {children}
    </div>
  )
}

function Row({ k, v }) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <span style={{ color: '#9ca3af', minWidth: 52 }}>{k}</span>
      <span style={{ wordBreak: 'break-all' }}>{v}</span>
    </div>
  )
}

// 素材面板：显示选中文件夹中的图片/视频，点击/拖入后放入画布
function AssetsPanel({ assets, placingAsset, onPlace, onCancel, onDragStart, onDragEnd }) {
  const fileInputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)
  const [localAssets, setLocalAssets] = useState(assets)

  // 同步外部 assets
  useEffect(() => { setLocalAssets(assets) }, [assets])

  // 处理文件上传（选择或拖入）
  function handleFiles(files) {
    const newAssets = []
    const exts = /\.(png|jpg|jpeg|gif|webp|bmp|svg|mp4|webm|ogg|mov|avi)$/i
    for (const file of files) {
      if (!exts.test(file.name)) continue
      const url = URL.createObjectURL(file)
      const isVideo = /\.(mp4|webm|ogg|mov|avi)$/i.test(file.name)
      newAssets.push({ name: file.name, url, type: isVideo ? 'video' : 'image' })
    }
    if (newAssets.length) setLocalAssets((prev) => [...prev, ...newAssets])
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={(e) => { setDragOver(false) }}
      onDrop={(e) => {
        e.preventDefault(); setDragOver(false)
        if (e.dataTransfer.files && e.dataTransfer.files.length) {
          handleFiles(e.dataTransfer.files)
        }
      }}
      style={{
        minHeight: 120,
        background: dragOver ? '#fef3c7' : 'transparent',
        border: dragOver ? '2px dashed #C41E24' : 'none',
        borderRadius: 6,
        padding: dragOver ? 12 : 0,
        transition: 'all .15s',
      }}
    >
      <p style={{ color: '#C41E24', fontWeight: 600, fontSize: 13, margin: '0 0 8px' }}>
        素材库（{localAssets.length} 个）
      </p>

      {/* 上传按钮 */}
      <div style={{ marginBottom: 10 }}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,video/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files.length) handleFiles(e.target.files)
            e.target.value = ''
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          style={{ ...btn('#4b5563'), width: '100%', fontSize: 12 }}
        >
          + 上传图片/视频
        </button>
        <p style={{ fontSize: 11, color: '#9ca3af', margin: '4px 0 0' }}>
          或拖拽文件到此处，也可直接拖入画布
        </p>
      </div>

      {localAssets.length === 0 && (
        <p style={{ color: '#9ca3af', fontSize: 13, lineHeight: 1.7 }}>
          选择文件夹后，其中的图片/视频会自动显示。
        </p>
      )}

      {localAssets.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {localAssets.map((a, i) => (
            <div
              key={i}
              draggable={!placingAsset}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', JSON.stringify({ url: a.url, type: a.type }))
                onDragStart(a)
              }}
              onDragEnd={() => onDragEnd()}
              onClick={() => onPlace(a)}
              title={'拖入画布或点击放置: ' + a.name}
              style={{
                border: '1px solid #d1d5db',
                borderRadius: 6,
                overflow: 'hidden',
                cursor: placingAsset ? 'default' : 'grab',
                background: '#f9fafb',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                userSelect: 'none',
              }}
            >
              {a.type === 'video' ? (
                <video src={a.url} style={{ width: '100%', height: 80, objectFit: 'cover' }} />
              ) : (
                <img src={a.url} style={{ width: '100%', height: 80, objectFit: 'cover' }} />
              )}
              <span style={{ fontSize: 11, color: '#6b7280', padding: '3px 4px', wordBreak: 'break-all', lineHeight: 1.3 }}>
                {a.name}
              </span>
            </div>
          ))}
        </div>
      )}

      {placingAsset && (
        <div style={{ marginTop: 12, padding: 10, background: '#fef3c7', borderRadius: 6, fontSize: 13, color: '#92400e' }}>
          📌 正在放置：<b>{placingAsset.name}</b>
          <br />
          点击画布中要放置的位置，或按 <b>Esc</b> 取消。
          <br />
          <button onClick={onCancel} style={{ marginTop: 6, ...btn('#6b7280') }}>取消放置</button>
        </div>
      )}

      {dragOver && (
        <div style={{ textAlign: 'center', color: '#C41E24', fontSize: 13, padding: 20 }}>
          📁 释放文件以上传
        </div>
      )}
    </div>
  )
}

const inp = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 8px',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  fontSize: 13,
}

function btn(bg) {
  return {
    background: bg,
    color: '#fff',
    border: 'none',
    padding: '7px 14px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
  }
}

function stripPx(v) {
  if (!v) return ''
  return v.replace(/px$/i, '')
}
function isNum(v) {
  return /^-?\d+(\.\d+)?$/.test(v)
}
function toHex(c) {
  if (!c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)') return ''
  if (/^#[0-9a-f]{3,8}$/i.test(c)) return c
  // rgb(...) 转为 hex（粗略）
  const m = c.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x))
    const h = (n) => ('0' + Math.round(n).toString(16)).slice(-2)
    return '#' + h(p[0]) + h(p[1]) + h(p[2])
  }
  return ''
}

// 从 selected 信息中提取宽高比（用于锁定纵横比）
function getAspectRatio(sel) {
  if (!sel) return null
  const w = parseFloat(sel.width)
  const h = parseFloat(sel.height)
  if (w > 0 && h > 0) return w / h
  return null
}

// dataUrl → Blob（用于处理 iframe 拖入的文件）
function dataUrlToBlob(dataUrl) {
  const parts = dataUrl.split(',')
  const mime = parts[0].match(/:(.*?);/)[1]
  const bytes = atob(parts[1])
  const arr = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
  return new Blob([arr], { type: mime })
}
