import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import editorRuntimeSrc from './editorRuntime.js?raw'
import {
  pickHtmlFile,
  isElectron,
  pickHtmlFolderBackend,
  buildFileMap,
  dirOf,
  toRelativePath,
} from './loadFolder.js'
import {
  stripScripts,
  rewriteAssets,
  restoreAndWrap,
  stripEditorParts,
  fileUrlMapper,
  injectAudioStartDelay,
} from './htmlProcess.js'
import { saveDraft, loadDraft, clearDraft } from './draftStore.js'
import { ANIM_EFFECTS, ANIM_ENGINE_PARTS, animEngineBootstrap } from './animEffects.js'

const STYLE_TAG =
  '<style id="zt-editor-style">' +
  '*{animation:none!important;transition:none!important;}' + // 编辑态冻结 CSS 动画/过渡，避免播放干扰拖拽；导出/草稿时随之移除
  '.zt-selected{outline:2px solid #C41E24!important;outline-offset:1px;}' +
  '.zt-binding-target{outline:3px dashed #0F6E56!important;outline-offset:2px;box-shadow:0 0 16px rgba(15,110,86,.35)!important;}' +
  '.zt-bound-highlight{outline:3px solid #C41E24!important;outline-offset:2px;box-shadow:0 0 16px rgba(196,30,36,.5)!important;}' +
  '.focus-group .focus-item{position:relative}' +
  '.focus-group.dim-others .focus-item{opacity:.35;filter:brightness(.7) blur(1px)}' +
  '.focus-group.dim-others .focus-item.zt-focus-active{opacity:1;filter:brightness(1) blur(0);transform:scale(1.12);z-index:3;box-shadow:0 0 50px rgba(196,30,36,.35)}' +
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

const BORDER_WIDTHS = ['0', '1', '2', '3', '4', '5', '6']
const RADIUS_VALUES = Array.from({ length: 21 }, (_, i) => String(i))
const FONT_SIZES = ['', '12', '14', '16', '18', '20', '24', '28', '32', '36', '40', '48', '56', '64', '72']
const BORDER_STYLES = [
  ['solid', '实线'],
  ['dashed', '虚线'],
  ['dotted', '点线'],
  ['double', '双线'],
  ['none', '无'],
]
const SHADOW_PRESETS = [
  ['none', '无阴影'],
  ['0 2px 8px rgba(0,0,0,.12)', '轻微'],
  ['0 4px 20px rgba(0,0,0,.15)', '中等'],
  ['0 8px 30px rgba(0,0,0,.25)', '较重'],
]

const RESOLUTIONS = [
  ['current', '当前屏幕'],
  ['', '编辑器窗口大小'],
  ['1920x1080', '1080P (1920×1080)'],
  ['2560x1440', '2K (2560×1440)'],
  ['3840x2160', '4K (3840×2160)'],
]

function download(filename, text) {
  const blob = text instanceof Blob ? text : new Blob([text], { type: 'text/html' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

export default function App() {
  const iframeRef = useRef(null)
  const fileMapRef = useRef(new Map())
  const activeHtmlRef = useRef('')
  const relMapRef = useRef(new Map())
  const scriptsRef = useRef([])
  const gridOnRef = useRef(false)
  const pendingSaveRef = useRef(false)
  const saveTimerRef = useRef(null)
  const restoredRef = useRef(false)
  const pendingCurrentRef = useRef(0)
  const lastSavedRef = useRef(0)

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
  const [subtitles, setSubtitles] = useState([]) // 字幕列表
  const [selectedSubIdx, setSelectedSubIdx] = useState(-1) // 时间轴选中字幕索引
  const [subBindingMode, setSubBindingMode] = useState(false) // 绑定模式激活
  const [bindingTarget, setBindingTarget] = useState(null) // { selector, tag, text } | null
  const [simRes, setSimRes] = useState('') // 模拟分辨率，如 '1920x1080'；''=编辑器窗口大小
  const [zoom, setZoom] = useState(1) // 画布缩放 0.5 ~ 1.5，0.1 步进
  const dragDataRef = useRef(null) // 拖拽中的素材信息
  const [ctxMenu, setCtxMenu] = useState(null) // 右键菜单 { x, y, editable, count, locked, group, anyLocked } | null
  const [clipCount, setClipCount] = useState(0) // 剪贴板元素数量（>0 复制/剪切后启用粘贴）
  const [layers, setLayers] = useState([]) // 当前页图层列表（顶层在前）
  const [playMode, setPlayMode] = useState(false) // 播放预览模式
  const [playCurrent, setPlayCurrent] = useState(0) // 播放中的当前页
  // OBS 系统级录制（全自动一键，成片直接落在当前 HTML 所在目录）
  const [obsRec, setObsRec] = useState({ recording: false, msg: '', filePath: '' })
  const [obsInteractDelay, setObsInteractDelay] = useState(0) // OBS 起播/导出 HTML 的「音频开始延迟」（秒，0.3 起即几百 ms 量级）：进画面先放首屏动画，N 秒后才出音频
  // OBS 录制方式固定为原生浏览器源（无临时窗口/文件，OBS 内置 CEF 直接渲染 HTML）。不再提供选择器。
  const OBS_CAPTURE_MODE = 'obs-browser-source'
  const obsRecRef = useRef(obsRec) // 异步/守卫里读最新值
  // 「录制 + 播放」联动标记：由「● OBS 录制」一键拉起的这次录制，播放结束要自动停录。
  // 单独点「▶ 本页预览」播放时不置位，播完不会误停正在进行的录制。
  const obsAutoStopRef = useRef(false)
  const [recRoot, setRecRoot] = useState('') // 当前编辑 HTML 所在目录（OBS 成片落点，经主进程取）
  const recRootRef = useRef('') // 同上，ref 版供异步回调用
  const pendingExportRef = useRef(null) // 等待 iframe 回传 HTML 的 Promise（导出用）
  const pendingRecordRef = useRef(null) // 临时录制落盘专用：等 iframe 回传序列化 HTML（与导出通道互不干扰）

  gridOnRef.current = gridOn
  activeHtmlRef.current = activeHtml
  recRootRef.current = recRoot // ref 是异步回调里的真实来源，state 用于 UI 显示
  obsRecRef.current = obsRec

  function send(msg) {
    iframeRef.current?.contentWindow?.postMessage(msg, '*')
  }

  // ---------- 加载 / 恢复 ----------
  // 点击「选择 HTML 文件」：
  // - Electron 环境：原生文件框筛选 .html，选中后加载该文件所在文件夹的全部资源
  // - 纯浏览器环境：退回为仅加载选中的单个文件
  async function handlePick() {
    setClipCount(0)
    try {
      if (isElectron()) {
        // 读整个文件夹（含图片/视频等资源），重建 File 映射
        const { mainKey, map } = await pickHtmlFolderBackend()
        fileMapRef.current = map
        setActiveHtml(mainKey)
        // 记下资源根目录：离屏录制要用它把相对资源改写成 file:// 绝对地址
        setRecRoot(await getResourceRoot())
        await loadHtml(mainKey, map)
      } else {
        const file = await pickHtmlFile()
        const map = buildFileMap([file]) // key = 文件名
        fileMapRef.current = map
        setActiveHtml(file.name)
        await loadHtml(file.name, map)
      }
    } catch (e) {
      if (e.message !== '已取消') alert('打开 HTML 文件失败：' + e.message)
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
    const subDataScript = buildSubtitleDataScript(scripts)
    const doc = processed.replace('</body>', STYLE_TAG + subDataScript + SCRIPT_TAG + '</body>')
    setReady(false)
    setPlayMode(false)
    finishRecording() // 加载/清空时兜底结束录制
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
    // 回填资源根目录：否则刷新恢复后录屏拿不到 root，会静默退回窗口捕获兜底方案
    setRecRoot(d.root || '')
    if (d.root) {
      try {
        if (window.ztRoot && window.ztRoot.set) {
          await window.ztRoot.set(recRootRef.current)
        }
      } catch (e) {}
    }
    pendingCurrentRef.current = d.current || 0
    const subDataScript = buildSubtitleDataScript(d.scripts || [])
    const doc = html.replace('</body>', STYLE_TAG + subDataScript + SCRIPT_TAG + '</body>')
    setReady(false)
    setPlayMode(false)
    finishRecording() // 加载/清空时兜底结束录制
    setSelected(null)
    restoredRef.current = true
    setRestored(true)
    setSrcdoc(doc)
  }

  // ---------- 自动保存草稿 ----------
  function scheduleSave() {
    if (!srcdoc) return // 无内容时不调度保存
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
        root: recRootRef.current, // 一并存下，刷新恢复后离屏录制仍可用
        savedAt: Date.now(),
      })
      lastSavedRef.current = Date.now()
    } catch (e) {
      console.warn('草稿保存失败', e)
    }
  }

  async function handleClearDraft() {
    if (!confirm('确定清除本地草稿？此操作不可撤销（不影响你磁盘上的原文件）。')) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    await clearDraft()
    setSrcdoc('')
    setReady(false)
    setPlayMode(false)
    finishRecording() // 加载/清空时兜底结束录制
    setTotal(0)
    setCurrent(0)
    setSelected(null)
    setSelCount(0)
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

  // 从原始脚本中取出 HTML 自带的原生播放器（含 startPlayback / slideTimings）
  function getNativePlayerScript() {
    const scripts = scriptsRef.current || []
    for (const s of scripts) {
      if (!/src=/.test(s) && s.indexOf('startPlayback') >= 0) {
        return s.replace(/<\/?script[^>]*>/g, '')
      }
    }
    return null
  }

  // ---------- OBS 系统级录制（全自动一键） ----------
  // 录制与播放解耦：播放只负责预览，录制是顶栏独立的「● OBS 录制」按钮。

  // 当前编辑 HTML 所在文件夹的磁盘绝对路径（仅桌面端有；浏览器模式返回空串）——OBS 成片落点
  async function getResourceRoot() {
    try {
      if (window.ztRoot && window.ztRoot.get) {
        const r = await window.ztRoot.get()
        return (r && r.root) || ''
      }
    } catch (e) {}
    return ''
  }

  async function handleStartPlay(from) {
    const nativeScript = getNativePlayerScript()
    // 「▶ 本页预览」只播放、不录制；「● OBS 录制」会在起录成功后反过来调用本函数自动从头播放（见 startObsRec）。
    // 录制必须伴随播放，否则录进去的是静止画面且没声音。
    send({ type: 'startPlay', from, nativeScript })
  }

  // OBS 系统级录制（全自动一键）：控制器自建场景、自动认 ztEdit 主窗口建窗口捕获源、
  // 铺满画布、缺音源自动补桌面音频，成片直接写到当前 HTML 所在目录。
  // 渲染端只给 outdir；窗口标题与全屏尺寸由主进程补齐（只有主进程拿得到原生窗口句柄）。
  // 取当前编辑的最终 HTML（内存落盘用）：触发 iframe 序列化 → 回包经 restoreAndWrap 还原相对资源/脚本。
  // 注意：必须发 requestSerialize（iframe 回 type:'serialize' 原始 HTML），不要发 requestExport——
  // requestExport 走 exportClean，会回 type:'export' 并触发「下载 edited.html」保存框，且永远不会回 serialize，
  // 会导致录制 Promise 永不 resolve、卡在「导出 HTML…」、还误生成 edited.html。
  function getEditedFinalHtml() {
    return new Promise((resolve) => {
      pendingRecordRef.current = { resolve }
      send({ type: 'requestSerialize' })
    }).then((h) => restoreAndWrap(h, relMapRef.current, scriptsRef.current))
  }

  // OBS 录制（脱离 ztEdit）：把内存 HTML 落盘到源目录临时文件，用系统浏览器打开，OBS 捕获浏览器窗口。
  // 互动延迟：起录后延迟 N 秒开始播放（给 OBS 稳定/画面对齐留时间；file:// 下默认已自动播放）。
  async function startObsRec() {
    setObsRec({ recording: false, msg: '导出 HTML…', filePath: '' })
    const outdir = recRootRef.current || (await getResourceRoot())
    if (!outdir) {
      setObsRec({ recording: false, msg: '未选择 HTML 文件，无法确定临时文件目录。请先「选择 HTML 文件」。' })
      return
    }
    let finalHtml
    try { finalHtml = await getEditedFinalHtml() }
    catch (e) {
      setObsRec({ recording: false, msg: '导出 HTML 失败，未开始录制' })
      return
    }
    const r = await window.ztRecSession.startOBS({
      outdir,
      html: finalHtml,
      captureMode: OBS_CAPTURE_MODE,
      interactDelaySec: obsInteractDelay,
    })
    if (r && r.ok) {
      const noAudio = r.audio && r.audio.indexOf('failed') === 0
      const fit = r.fit ? `画布已对齐 ${r.fit}` : ''
      const modeLabel = 'OBS 浏览器源'
      setObsRec({
        recording: true,
        msg: (noAudio ? '录制中（⚠可能无声，检查桌面音频）' : `录制中（${modeLabel}）`) + (fit ? ' · ' + fit : '') + (obsInteractDelay ? ` · 音频延迟 ${Math.round(obsInteractDelay * 1000)}ms` : ''),
        filePath: r.tempFile || '',
      })
    } else setObsRec({ recording: false, msg: String((r && r.error) || '启动失败').slice(0, 140), filePath: '' })
  }
  async function stopObsRec() {
    obsAutoStopRef.current = false // 手动收尾，解除播放结束的自动停录
    const r = await window.ztRecSession.stopOBS()
    if (r && r.ok) setObsRec({ recording: false, msg: r.skipped ? '未录制' : '已停止', filePath: r.filePath || '' })
    else setObsRec({ recording: false, msg: String((r && r.error) || '停止失败').slice(0, 100), filePath: '' })
  }

  // 换文件 / 清草稿时的兜底：若 OBS 正在录，先停掉并回传成片路径。
  // 正常收尾走 playState：由「● OBS 录制」一键拉起的录制，播放结束会自动停录。
  async function finishRecording() {
    if (!obsRecRef.current || !obsRecRef.current.recording) return
    obsAutoStopRef.current = false
    try {
      const r = await window.ztRecSession.stopOBS()
      if (r && r.ok) setObsRec({ recording: false, msg: r.skipped ? '未录制' : '已停止', filePath: r.filePath || '' })
      else setObsRec({ recording: false, msg: String((r && r.error) || '停止失败').slice(0, 100), filePath: '' })
    } catch (e) {
      setObsRec({ recording: false, msg: 'OBS 停止异常', filePath: '' })
    }
  }

  // ---------- 通信 ----------
  useEffect(() => {
    function onMessage(e) {
      const m = e.data || {}
      if (m.type === 'ready') {
        setReady(true)
        // 把动画引擎源码下发给 iframe：预览、播放、以及注入原生脚本前的引擎替换都靠它。
        // 引擎只在这里传一份，iframe 内不再自带 keyframes 表（避免三处副本再次漂移）。
        send({ type: 'animEngine', bootstrap: animEngineBootstrap(), parts: ANIM_ENGINE_PARTS })
        if (gridOnRef.current) send({ type: 'toggleGrid', on: true, size: 20 })
        if (pendingCurrentRef.current) {
          send({ type: 'goto', index: pendingCurrentRef.current })
          pendingCurrentRef.current = 0
        }
      } else if (m.type === 'pages') {
        setTotal(m.total)
        setCurrent(m.current)
        setSelectedSubIdx(-1)
        requestSubtitles()
      } else if (m.type === 'selection') {
        setSelCount(m.count)
        setSelected(m.primary)
        // 注意：画布元素选中【不应】清空字幕选中（selectedSubIdx），
        // 否则点字幕块后 runtime 回传 selection 会把选中态冲掉，
        // 导致「解除绑定」按钮走到 unbindSelectedElement 分支而解不掉字幕。
      } else if (m.type === 'deselected') {
        setSelCount(0)
        setSelected(null)
        setSelectedSubIdx(-1)
      } else if (m.type === 'changed') {
        scheduleSave()
    } else if (m.type === 'serialize') {
      // 录制取页与草稿保存共用同一份回包，两条链路互不干扰
      const p = pendingExportRef.current
      if (p) {
        pendingExportRef.current = null
        p.resolve(m.html)
      }
      const pr = pendingRecordRef.current
      if (pr) {
        pendingRecordRef.current = null
        pr.resolve(m.html)
      }
      if (pendingSaveRef.current) {
          pendingSaveRef.current = false
          actuallySave(m.html, m.current)
        }
      } else if (m.type === 'export') {
        let finalHtml = restoreAndWrap(m.html, relMapRef.current, scriptsRef.current)
        // 导出 HTML 也带上「音频开始延迟」：手动把文件丢进 OBS 浏览器源时同样先放动画再出音频
        if (obsInteractDelay) finalHtml = injectAudioStartDelay(finalHtml, Math.round(obsInteractDelay * 1000))
        download('edited.html', finalHtml)
      } else if (m.type === 'zoom') {
        // Ctrl+滚轮缩放模拟画布：50% ~ 150%，10% 步进
        setZoom((z) => {
          const step = m.deltaY < 0 ? 0.1 : -0.1
          const next = Math.min(1.5, Math.max(0.5, Math.round((z + step) * 10) / 10))
          return next
        })
      } else if (m.type === 'contextmenu') {
        setCtxMenu(m)
      } else if (m.type === 'playState') {
        // 播放开始/结束（结束可能由 iframe 内 Esc 或音频播完触发）
        setPlayMode(m.playing)
        if (typeof m.current === 'number') { setPlayCurrent(m.current); setCurrent(m.current) }
        if (!m.playing) {
          // 回到编辑模式：重新拉取页面信息，确保面板同步
          setSelected(null)
          setSelCount(0)
          // 录制 + 播放联动：只要这次录制是「● OBS 录制」一键拉起的，播放一结束
          // （音频播完、或 iframe 内按 Esc 退出）就自动收尾停录，不必再手动点停止。
          if (obsAutoStopRef.current) {
            obsAutoStopRef.current = false
            stopObsRec()
          }
        }
      } else if (m.type === 'playProgress') {
        setPlayCurrent(m.current)
      } else if (m.type === 'canvasPointerDown') {
        setCtxMenu(null)
      } else if (m.type === 'clipboard') {
        setClipCount(m.count || 0)
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
      } else if (ctrl && k === 'x') {
        send({ type: 'cut' })
        e.preventDefault()
      } else if (ctrl && k === 'c') {
        send({ type: 'copy' })
        e.preventDefault()
      } else if (ctrl && k === 'v') {
        send({ type: 'paste' })
        e.preventDefault()
      } else if (!ctrl && ['arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k) && selected) {
        const step = e.shiftKey ? 10 : 1
        const dx = k === 'arrowleft' ? -step : (k === 'arrowright' ? step : 0)
        const dy = k === 'arrowup' ? -step : (k === 'arrowdown' ? step : 0)
        send({ type: 'moveBy', dx, dy })
        e.preventDefault()
      } else if (!ctrl && (k === 'delete' || k === 'backspace')) {
        // 仅在画布聚焦且无输入框时删除（父层兜底，iframe 内由 runtime 处理，两者不同时生效）
        if (selected) { send({ type: 'delete' }); e.preventDefault() }
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
  }, [selCount, selected])

  // 捕获用的浏览器窗口被用户关掉 → 主进程已自动停 OBS + 删临时文件，这里同步退出「录制中」UI 态
  useEffect(() => {
    if (!window.ztRecSession || !window.ztRecSession.onBrowserClosed) return
    window.ztRecSession.onBrowserClosed((r) => {
      setObsRec((prev) =>
        prev && prev.recording
          ? { recording: false, msg: (r && r.skipped) ? '已停止' : '浏览器已关闭 · 已停止', filePath: (r && r.filePath) || '' }
          : prev
      )
    })
  }, [])

  // 打开 HTML 文件时，同步提取图片/视频素材
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
      list.push({ name: path.split('/').pop() || path, path, url, type: isVideo ? 'video' : 'image' })
    }
    setAssets(list)
  }, [activeHtml]) // 打开新的 HTML 文件时重扫素材

  // 拖拽素材到画布
  function handleDragStart(asset) {
    dragDataRef.current = asset
    send({ type: 'assetDragStarted' })
  }
  function handleDragEnd() {
    dragDataRef.current = null
    send({ type: 'assetDragEnded' })
  }

  // 字幕/时间轴相关操作
  function requestSubtitles() {
    send({ type: 'requestSubtitles' })
  }
  function handleSelectSub(i) {
    var idx = i === selectedSubIdx ? -1 : i
    setSelectedSubIdx(idx)
    if (idx >= 0 && subtitles[idx] && subtitles[idx].boundTo) {
      // 点击字幕时，选中它绑定的画面元素，便于直接修改动画/样式
      send({ type: 'selectBound', selector: subtitles[idx].boundTo })
    } else {
      send({ type: 'clearBoundHighlight' })
    }
  }
  function handleUnbindSub() {
    if (selectedSubIdx >= 0) {
      send({ type: 'unbindSubtitle', subtitleIndex: selectedSubIdx })
      return
    }
    // 如果当前选中的是画面元素，直接解除它身上的绑定
    if (selected) send({ type: 'unbindSelectedElement' })
  }
  function handleMoveSubtitle(dir) {
    if (selectedSubIdx < 0) return
    send({ type: 'moveSubtitle', direction: dir, subtitleIndex: selectedSubIdx })
    setSelectedSubIdx(-1)
  }
  function handleStartBinding() {
    if (selectedSubIdx < 0) return
    send({ type: 'startBinding', subtitleIndex: selectedSubIdx })
  }
  function handleConfirmBinding() {
    send({ type: 'confirmBinding' })
  }
  function handleCancelBinding() {
    send({ type: 'cancelBinding' })
    setSubBindingMode(false)
    setBindingTarget(null)
  }

  // 放置素材到画布
  function registerAssetPath(asset) {
    // 素材来自所选文件夹时，记录 blob -> 相对路径，导出时可恢复为正常文件引用
    if (!asset || !asset.path) return
    const rel = toRelativePath(dirOf(activeHtmlRef.current), asset.path)
    if (rel) relMapRef.current.set(asset.url, rel)
  }

  function handlePlaceAsset(asset) {
    registerAssetPath(asset)
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
      // 图层面板消息
      if (m.type === 'layers') {
        setLayers(m.layers || [])
      }
      // 字幕/时间轴消息
      if (m.type === 'subtitles') {
        setSubtitles(m.subtitles || [])
        setSelectedSubIdx(-1)
      }
      if (m.type === 'subtitlesMoved') {
        setSubtitles(m.subtitles || [])
        setSelectedSubIdx(-1)
        send({ type: 'clearBoundHighlight' })
      }
      if (m.type === 'bindingModeStarted') {
        setSubBindingMode(true)
        setBindingTarget(null)
      }
      if (m.type === 'bindingNotSupported') {
        alert('当前页字幕来自页面脚本中的 subtitles 数组，不支持绑定。\n如需绑定，请在 HTML 中给字幕元素添加 data-zt-role="subtitle" 属性。')
      }
      if (m.type === 'bindingTarget') {
        setBindingTarget({ selector: m.selector, tag: m.tag, text: (m.text || '').slice(0, 30) })
      }
      if (m.type === 'bindingConfirmed') {
        setSubBindingMode(false)
        setBindingTarget(null)
        setSelectedSubIdx(-1)
        send({ type: 'clearBoundHighlight' })
      }
      if (m.type === 'bindingCancelled') {
        setSubBindingMode(false)
        setBindingTarget(null)
      }
      if (m.type === 'unbindFailed') {
        console.warn('[ZT-Edit] 解除绑定失败:', m)
        alert('解除绑定失败：未找到对应字幕。\n可能原因：字幕已被删除或页面结构变化，请刷新后再试。')
      }
      // 拖拽放置：iframe 告知坐标，我方回传素材信息
      if (m.type === 'assetDropPosition') {
        const d = dragDataRef.current
        if (d) {
          registerAssetPath(d)
          send({ type: 'insertAsset', url: d.url, assetType: d.type, x: m.x, y: m.y })
          dragDataRef.current = null
        }
      }
      // 文件拖入画布：iframe 传来 dataUrl，创建 blob URL 并插入
      if (m.type === 'fileDropped') {
        const blob = dataUrlToBlob(m.dataUrl)
        const url = URL.createObjectURL(blob)
        assetUrlsRef.current.push(url)
        // 如果拖入的是所选文件夹里的文件，按相对路径导出；否则用 dataUrl 内嵌，避免导出 blob
        let droppedPath = null
        if (m.size != null) {
          for (const [fp, f] of fileMapRef.current) {
            if (f.name === m.name && f.size === m.size) {
              droppedPath = fp
              break
            }
          }
        }
        if (droppedPath) {
          relMapRef.current.set(url, toRelativePath(dirOf(activeHtmlRef.current), droppedPath))
        } else if (m.dataUrl) {
          relMapRef.current.set(url, m.dataUrl)
        }
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

  // 识别当前屏幕：CSS 视口（浏览器实际排版尺寸）+ 物理分辨率
  const dpr = window.devicePixelRatio || 1
  const cssResW = window.screen.width || 0
  const cssResH = window.screen.height || 0
  const physicalResW = Math.round(cssResW * dpr)
  const physicalResH = Math.round(cssResH * dpr)

  const simDim =
    simRes === 'current'
      ? [cssResW, cssResH] // 用浏览器实际排版视口，才能匹配你在浏览器中看到的占比
      : simRes
        ? simRes.split('x').map(Number)
        : null
  const simW = simDim ? simDim[0] : null
  const simH = simDim ? simDim[1] : null

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <div
        className="zt-chrome"
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
          选择 HTML 文件
        </button>

        <span style={{ width: 1, height: 22, background: '#374151' }} />

        <button onClick={() => send({ type: 'undo' })} disabled={!ready || playMode} title="撤销（Ctrl+Z）" style={btn('#374151')}>
          撤销
        </button>
        <button onClick={() => send({ type: 'redo' })} disabled={!ready || playMode} title="重做（Ctrl+Shift+Z）" style={btn('#374151')}>
          重做
        </button>
        <button onClick={() => send({ type: 'delete' })} disabled={!selected || playMode} title="删除选中（Delete）" style={btn('#7f1d1d')}>
          删除
        </button>

        <span style={{ width: 1, height: 22, background: '#374151' }} />

        <button onClick={toggleGrid} disabled={playMode} style={btn(gridOn ? '#0F6E56' : '#374151')}>
          {gridOn ? '网格：开' : '网格：关'}
        </button>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#d1d5db' }}>
          分辨率:
          <select
            value={simRes}
            onChange={(e) => {
              setSimRes(e.target.value)
              setZoom(1)
            }}
            style={{ ...btn('#374151'), minWidth: 42 }}
            title="模拟浏览器分辨率，查看元素与屏幕的占比"
          >
            {RESOLUTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {v === 'current' ? `当前屏幕 (CSS ${cssResW}×${cssResH} / 物理 ${physicalResW}×${physicalResH})` : l}
              </option>
            ))}
          </select>
        </label>
        <span style={{ fontSize: 12, color: '#d1d5db', minWidth: 60, textAlign: 'center' }}>
          缩放 {Math.round(zoom * 100)}%
        </span>

        <button
          onClick={() => send({ type: 'resetElement' })}
          disabled={!selected || playMode}
          style={btn('#374151')}
        >
          重置选中
        </button>

        <span style={{ width: 1, height: 22, background: '#374151' }} />

        {playMode ? (
          <>
            <span style={{ fontSize: 12, color: '#fbbf24', fontWeight: 600 }}>
              ▶ 播放中 · 第 {playCurrent + 1}/{total} 页（Esc 停止）
            </span>
            {obsRec.recording && (
              <span style={{ fontSize: 12, color: '#f87171', fontWeight: 700 }}>● 录制中</span>
            )}
            <button
              onClick={() => send({ type: 'stopPlay' })}
              title="停止播放，返回编辑模式"
              style={btn('#C41E24')}
            >
              ⏹ 停止播放
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => handleStartPlay(current)}
              disabled={!ready || !total}
              title="从当前页开始播放预览（含音频）"
              style={btn('#0F6E56')}
            >
              ▶ 本页预览
            </button>
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#d1d5db' }}
              title="进画面后延迟多久才出音频：先放首屏 / 标题动画，避免一进画面就爆音、观众没准备。应用于 OBS 录制（落盘临时 HTML）与导出 HTML。"
            >
              音频延迟
              <select
                value={obsInteractDelay}
                onChange={(e) => setObsInteractDelay(parseFloat(e.target.value))}
                disabled={obsRec.recording}
                style={{ ...btn('#374151'), minWidth: 70 }}
              >
                <option value={0}>不延迟</option>
                <option value={0.3}>300ms</option>
                <option value={0.5}>500ms</option>
                <option value={0.8}>800ms</option>
                <option value={1}>1.0s</option>
                <option value={1.5}>1.5s</option>
                <option value={2}>2.0s</option>
                <option value={3}>3.0s</option>
              </select>
            </label>
            <button
              onClick={obsRec.recording ? stopObsRec : startObsRec}
              disabled={!recRoot && !obsRec.recording}
              style={btn(obsRec.recording ? '#7f1d1d' : '#1d4ed8')}
              title="OBS 系统级录制：自动建场景 + 画面源（窗口捕获 / 浏览器源）+ 音频兜底，成片直接落在当前 HTML 所在目录"
            >
              {obsRec.recording ? '■ 停止 OBS' : '● OBS 录制'}
            </button>
            {obsRec.msg && (
              <span style={{ fontSize: 11, color: obsRec.recording ? '#fca5a5' : '#9ca3af' }} title={obsRec.msg}>
                {obsRec.msg}
              </span>
            )}
            {obsRec.filePath && (
              <span style={{ fontSize: 11, color: '#a7f3d0' }} title={obsRec.filePath}>
                {obsRec.filePath.split(/[\\/]/).pop()}
              </span>
            )}
          </>
        )}
        <span style={{ width: 1, height: 22, background: '#374151' }} />

        <button onClick={handleExport} disabled={!ready || playMode} style={btn('#2563eb')}>
          导出 HTML
        </button>
        <button onClick={handleClearDraft} disabled={!restored} title="清除本地草稿" style={btn('#4b5563')}>
          清除草稿
        </button>

        <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 'auto' }}>
          📁 本地读取，文件不会上传到任何服务器
        </span>
      </div>

      {/* 页面预览 tab 条：点击快速跳转；播放模式下点击从该页续播 */}
      {total > 0 && (
        <div
          className="zt-chrome"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 12px',
            background: playMode ? '#111827' : '#f3f4f6',
            borderBottom: '1px solid #d1d5db',
            overflowX: 'auto',
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => send(playMode ? { type: 'playGoto', index: (playMode ? playCurrent : current) - 1 } : { type: 'prev' })}
            disabled={playMode}
            title={playMode ? '播放中不可切页，请先停止' : '上一页'}
            style={{
              minWidth: 34, padding: '3px 8px', border: 'none', borderRadius: 6,
              fontSize: 13, fontWeight: 700, marginRight: 2,
              background: '#e5e7eb', color: '#374151',
              opacity: (playMode || (playMode ? playCurrent <= 0 : current <= 0)) ? 0.4 : 1,
              cursor: playMode ? 'not-allowed' : 'pointer',
            }}
          >
            ‹
          </button>
          <span style={{ fontSize: 12, color: playMode ? '#fbbf24' : '#6b7280', marginRight: 6, whiteSpace: 'nowrap' }}>
            {playMode ? '预览' : '页面'}
          </span>
          {Array.from({ length: total }, (_, i) => {
            const active = playMode ? i === playCurrent : i === current
            return (
              <button
                key={i}
                onClick={() => { if (!playMode) send({ type: 'goto', index: i }) }}
                title={playMode ? `播放中不可切页，请先停止（当前第 ${playCurrent + 1} 页）` : `跳到第 ${i + 1} 页`}
                disabled={playMode}
                style={{
                  minWidth: 34,
                  padding: '3px 8px',
                  border: 'none',
                  borderRadius: 6,
                  cursor: playMode ? 'not-allowed' : 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                  background: active ? '#C41E24' : '#e5e7eb',
                  color: active ? '#fff' : '#374151',
                  opacity: playMode ? 0.55 : 1,
                }}
              >
                {i + 1}
              </button>
            )
          })}
          <button
            onClick={() => send(playMode ? { type: 'playGoto', index: playCurrent + 1 } : { type: 'next' })}
            disabled={playMode}
            title={playMode ? '播放中不可切页，请先停止' : '下一页'}
            style={{
              minWidth: 34, padding: '3px 8px', border: 'none', borderRadius: 6,
              fontSize: 13, fontWeight: 700, marginLeft: 2,
              background: '#e5e7eb', color: '#374151',
              opacity: (playMode || (playMode ? playCurrent >= total - 1 : current >= total - 1)) ? 0.4 : 1,
              cursor: playMode ? 'not-allowed' : 'pointer',
            }}
          >
            ›
          </button>
        </div>
      )}

      <div className="zt-main" style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div
          style={{
            flex: 1,
            background: '#e5e7eb',
            position: 'relative',
            overflow: 'auto',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'flex-start',
            padding: 12,
          }}
        >
          {srcdoc ? (
            <div
              className="zt-canvas-box"
              style={
                simW
                  ? {
                      width: simW * zoom,
                      height: simH * zoom,
                      position: 'relative',
                      overflow: 'hidden',
                      boxShadow: '0 2px 16px rgba(0,0,0,.15)',
                      flex: '0 0 auto',
                      background: '#fff',
                      margin: 'auto',
                    }
                  : { width: '100%', height: '100%', position: 'relative', overflow: 'visible' }
              }
            >
              <iframe
                ref={iframeRef}
                title="canvas"
                srcDoc={srcdoc}
                sandbox="allow-scripts allow-same-origin allow-popups"
                style={{
                  width: simW ? simW : '100%',
                  height: simH ? simH : '100%',
                  border: 'none',
                  background: '#fff',
                  transform: `scale(${zoom})`,
                  transformOrigin: 'top left',
                }}
              />
            </div>
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

        {!playMode && (
        <div
          className="zt-side"
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
              ['assets', '素材'],
              ['layers', '图层'],
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
            {tab === 'prop' && (
              <PropPanel selected={selected} send={send} selCount={selCount} aspectLock={aspectLock} setAspectLock={setAspectLock} />
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
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
              />
            )}
            {tab === 'layers' && (
              <LayersPanel
                layers={layers}
                current={current}
                total={total}
                send={send}
                selectedSubIdx={selectedSubIdx}
                onSelectSub={handleSelectSub}
              />
            )}
          </div>
        </div>
        )}
      </div>
      {!playMode && (
      <TimelinePanel
        subtitles={subtitles}
        selectedSubIdx={selectedSubIdx}
        onSelectSub={handleSelectSub}
        subBindingMode={subBindingMode}
        bindingTarget={bindingTarget}
        onPrevPage={handleMoveSubtitle}
        onNextPage={handleMoveSubtitle}
        onBind={handleStartBinding}
          onUnbind={handleUnbindSub}
        onConfirm={handleConfirmBinding}
        onCancelBind={handleCancelBinding}
        current={current}
        total={total}
        selected={selected}
        send={send}
      />
      )}
      <ContextMenu menu={ctxMenu} zoom={zoom} iframeRef={iframeRef} selCount={selCount} send={send} onClose={() => setCtxMenu(null)} clipCount={clipCount} />
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
  const [borderWidth, setBorderWidth] = useState('0')
  const [borderStyle, setBorderStyle] = useState('solid')
  const [borderColor, setBorderColor] = useState('#000000')
  const [borderRadius, setBorderRadius] = useState('')
  const [boxShadow, setBoxShadow] = useState('none')
  const [text, setText] = useState('')
  const replaceInputRef = useRef(null)

  // 选中变化时，用计算样式回填（让用户看到当前值）
  useEffect(() => {
    if (!selected) {
      setWidth(''); setHeight(''); setColor(''); setBg(''); setFont(''); setSize(''); setWeight('')
      setText(''); setBorderWidth('0'); setBorderStyle('solid'); setBorderColor('#000000')
      setBorderRadius(''); setBoxShadow('none')
      return
    }
    setWidth(stripPx(selected.width))
    setHeight(stripPx(selected.height))
    setColor(toHex(selected.color))
    setBg(toHex(selected.backgroundColor))
    setFont(selected.fontFamily || '')
    setSize(stripPx(selected.fontSize))
    setWeight(selected.fontWeight === '400' || selected.fontWeight === 'normal' ? '400' : selected.fontWeight)
    setText(selected.text || '')
    const bm = String(selected.border || '').match(/(\d+(?:\.\d+)?)px\s+(\w+)\s+(.*)/)
    setBorderWidth(bm ? bm[1] : '0')
    setBorderStyle(bm ? bm[2] : 'solid')
    setBorderColor(bm ? toHex(bm[3]) || '#000000' : '#000000')
    setBorderRadius(stripPx(selected.borderRadius) || '0')
    setBoxShadow(selected.boxShadow && selected.boxShadow !== 'none' ? '0 4px 20px rgba(0,0,0,.15)' : 'none')
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
    const bw = over && over.borderWidth !== undefined ? over.borderWidth : borderWidth
    const bst = over && over.borderStyle !== undefined ? over.borderStyle : borderStyle
    const bc = over && over.borderColor !== undefined ? over.borderColor : borderColor
    const br = over && over.borderRadius !== undefined ? over.borderRadius : borderRadius
    const sh = over && over.boxShadow !== undefined ? over.boxShadow : boxShadow
    // 只有非空字符串才加入（空字符串 = 不修改）
    if (w !== '') styles.width = w + (isNum(w) ? 'px' : '')
    if (h !== '') styles.height = h + (isNum(h) ? 'px' : '')
    if (c !== '') styles.color = c
    if (b !== '') styles.backgroundColor = b
    if (f !== '') styles.fontFamily = f
    if (s !== '') styles.fontSize = s + (isNum(s) ? 'px' : '')
    if (wt !== '') styles.fontWeight = wt
    if (bw !== '' && bw !== '0') styles.border = bw + 'px ' + (bst || 'solid') + ' ' + (bc || '#000000')
    else if (bw === '0') styles.border = 'none'
    if (br !== '') styles.borderRadius = br + (isNum(br) ? 'px' : '')
    if (sh !== '') styles.boxShadow = sh === 'none' ? 'none' : sh
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

  const noSel = !selected

  return (
    <div style={{ fontSize: 13 }}>
      {noSel ? (
        <p style={{ color: '#9ca3af', fontSize: 13, margin: '0 0 10px' }}>请先选中一个元素</p>
      ) : (
        <p style={{ color: '#C41E24', fontWeight: 600, margin: '0 0 10px' }}>
          已选中 {selCount} 个元素
        </p>
      )}

      <div style={{ opacity: noSel ? 0.5 : 1, pointerEvents: noSel ? 'none' : 'auto' }}>
      {/* 宽高一行 */}
      <div style={{ display: 'flex', gap: 8 }}>
        <Field label="宽度" grow>
          <input style={inp} value={width} onChange={(e) => { setWidth(e.target.value); if (aspectLock && e.target.value) { const r = getAspectRatio(selected); if (r) setHeight(String(Math.round(parseFloat(e.target.value) / r))); } }} onBlur={apply} onKeyDown={enterApply} placeholder="200" />
        </Field>
        <Field label="高度" grow>
          <input style={inp} value={height} onChange={(e) => { setHeight(e.target.value); if (aspectLock && e.target.value) { const r = getAspectRatio(selected); if (r) setWidth(String(Math.round(parseFloat(e.target.value) * r))); } }} onBlur={apply} onKeyDown={enterApply} placeholder="100" />
        </Field>
      </div>

      {/* 锁定纵横比 */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, color: '#374151', marginBottom: 8 }}>
        <input type="checkbox" checked={aspectLock} onChange={(e) => setAspectLock(e.target.checked)} />
        锁定纵横比
      </label>

      {/* 三个颜色选框，各占一行 */}
      <Field label="文字颜色">
        <input type="color" style={{ ...inp, padding: 2 }} value={color || '#000000'} onChange={(e) => { setColor(e.target.value); apply({ color: e.target.value }) }} />
      </Field>
      <Field label="背景颜色">
        <input type="color" style={{ ...inp, padding: 2 }} value={bg || '#000000'} onChange={(e) => { setBg(e.target.value); apply({ bg: e.target.value }) }} />
      </Field>
      <Field label="边框颜色">
        <input type="color" style={{ ...inp, padding: 2 }} value={borderColor || '#000000'} onChange={(e) => { setBorderColor(e.target.value); apply({ borderColor: e.target.value }) }} />
      </Field>

      {/* 边框宽度/样式一行 */}
      <div style={{ display: 'flex', gap: 8 }}>
        <Field label="边框宽度" grow>
          <select style={inp} value={borderWidth} onChange={(e) => { const v = e.target.value; setBorderWidth(v); apply({ borderWidth: v }) }}>
            {BORDER_WIDTHS.map((v) => <option key={v} value={v}>{v}px</option>)}
          </select>
        </Field>
        <Field label="边框样式" grow>
          <select style={inp} value={borderStyle} onChange={(e) => { const v = e.target.value; setBorderStyle(v); apply({ borderStyle: v }) }}>
            {BORDER_STYLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
      </div>

      {/* 圆角/阴影一行 */}
      <div style={{ display: 'flex', gap: 8 }}>
        <Field label="圆角" grow>
          <select style={inp} value={borderRadius} onChange={(e) => { const v = e.target.value; setBorderRadius(v); apply({ borderRadius: v }) }}>
            {RADIUS_VALUES.map((v) => <option key={v} value={v}>{v}px</option>)}
          </select>
        </Field>
        <Field label="阴影" grow>
          <select style={inp} value={boxShadow} onChange={(e) => { const v = e.target.value; setBoxShadow(v); apply({ boxShadow: v }) }}>
            {SHADOW_PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
      </div>

      <Field label="字体">
        <select style={inp} value={font} onChange={(e) => { const v = e.target.value; setFont(v); apply({ font: v }) }}>
          {FONTS.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </Field>

      {/* 字号/字重一行 */}
      <div style={{ display: 'flex', gap: 8 }}>
        <Field label="字号" grow>
          <select style={inp} value={size} onChange={(e) => { const v = e.target.value; setSize(v); apply({ size: v }) }}>
            {FONT_SIZES.map((v) => <option key={v} value={v}>{v ? v + 'px' : '（不修改）'}</option>)}
          </select>
        </Field>
        <Field label="字重" grow>
          <select style={inp} value={weight} onChange={(e) => { const v = e.target.value; setWeight(v); apply({ weight: v }) }}>
            {WEIGHTS.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </Field>
      </div>

      <div style={{ marginTop: 8, marginBottom: 4, color: '#6b7280' }}>文本内容（双击画布也可直接改）</div>
      <textarea
        style={{ ...inp, height: 60, padding: '8px 10px', resize: 'vertical' }}
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

        {selected && selected.tag === 'IMG' && (
          <div style={{ marginTop: 10 }}>
            <input
              ref={replaceInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files && e.target.files[0]
                if (f) {
                  const reader = new FileReader()
                  reader.onload = () => send({ type: 'replaceImage', url: reader.result })
                  reader.readAsDataURL(f)
                }
                e.target.value = ''
              }}
            />
            <button
              onClick={() => replaceInputRef.current?.click()}
              style={{ ...btn('#4b5563'), width: '100%', fontSize: 12 }}
            >
              替换图片
            </button>
          </div>
        )}
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
    </div>
  )
}

function Field({ label, children, grow }) {
  return (
    <div style={{ marginBottom: 8, flex: grow ? 1 : undefined, minWidth: 0 }}>
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

function StepperInput({ value, onChange, step = 1, min, max, width = 90, placeholder, disabled, style, dark }) {
  const num = parseFloat(value)
  const isValid = !isNaN(num) && String(value).trim() !== ''

  function adjust(delta) {
    if (disabled) return
    const current = isValid ? num : 0
    let next = +(current + delta).toFixed(2)
    if (min !== undefined && next < min) next = min
    if (max !== undefined && next > max) next = max
    onChange(String(next))
  }

  function handleChange(e) { onChange(e.target.value) }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      const n = parseFloat(value)
      if (!isNaN(n)) {
        let v = n
        if (min !== undefined && v < min) v = min
        if (max !== undefined && v > max) v = max
        onChange(String(v))
      }
    }
    if (e.key === 'ArrowUp') { e.preventDefault(); adjust(step) }
    if (e.key === 'ArrowDown') { e.preventDefault(); adjust(-step) }
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'stretch',
      background: dark ? '#1f2937' : '#ffffff',
      borderRadius: 6,
      boxShadow: dark ? 'none' : '0 2px 6px rgba(0,0,0,0.10)',
      border: dark ? '1px solid #4b5563' : 'none',
      overflow: 'hidden',
      width,
      height: 26,
      opacity: disabled ? 0.5 : 1,
      ...style,
    }}>
      <input
        type="text"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={placeholder}
        style={{
          border: 'none',
          outline: 'none',
          padding: '1px 4px 1px 9px',
          fontSize: 12,
          fontWeight: 600,
          flex: 1,
          minWidth: 0,
          color: dark ? '#e5e7eb' : '#1f2937',
          background: 'transparent',
          textAlign: 'left',
        }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, width: 26, alignSelf: 'stretch' }}>
        <button
          onClick={() => adjust(step)}
          disabled={disabled}
          style={{
            border: 'none',
            background: '#C41E24',
            flex: 1,
            minHeight: 0,
            cursor: disabled ? 'not-allowed' : 'pointer',
            fontSize: 13,
            fontWeight: 700,
            lineHeight: 1,
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >+</button>
        <button
          onClick={() => adjust(-step)}
          disabled={disabled}
          style={{
            border: 'none',
            borderTop: '1px solid rgba(255,255,255,0.25)',
            background: '#b01a20',
            flex: 1,
            minHeight: 0,
            cursor: disabled ? 'not-allowed' : 'pointer',
            fontSize: 13,
            fontWeight: 700,
            lineHeight: 1,
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >−</button>
      </div>
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
          {localAssets.map((a, i) => {
            const isPlacing = placingAsset && placingAsset.url === a.url && placingAsset.name === a.name
            return (
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
                border: isPlacing ? '2px solid #C41E24' : '1px solid #d1d5db',
                borderRadius: 6,
                overflow: 'hidden',
                cursor: placingAsset ? 'default' : 'grab',
                background: isPlacing ? '#fff5f5' : '#f9fafb',
                boxShadow: isPlacing ? '0 0 0 2px rgba(196,30,36,.12)' : 'none',
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
            )
          })}
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

// 图层面板（当前页元素列表，按 z-index 降序，顶层在前）
function LayersPanel({ layers, current, total, send, selectedSubIdx, onSelectSub }) {
  const [dragIdx, setDragIdx] = useState(null)
  const [overIdx, setOverIdx] = useState(null)

  function handleDragStart(e, i) {
    setDragIdx(i)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(i))
  }

  function handleDragOver(e, i) {
    e.preventDefault()
    setOverIdx(i)
  }

  function handleDrop(e, i) {
    e.preventDefault()
    if (dragIdx !== null && dragIdx !== i) {
      send({ type: 'reorderLayers', fromIdx: dragIdx, toIdx: i })
    }
    setDragIdx(null)
    setOverIdx(null)
  }

  function handleDragEnd() {
    setDragIdx(null)
    setOverIdx(null)
  }

  // 找到第一个字幕元素的索引（用于插入视觉分隔线）
  var firstSubIdx = -1
  for (var si = 0; si < layers.length; si++) {
    if (layers[si].role === 'subtitle') {
      firstSubIdx = si
      break
    }
  }

  return (
    <div>
      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>
        当前页 {current + 1}/{total}  ·  {layers.length} 个元素
      </p>
      {layers.length === 0 && (
        <p style={{ color: '#9ca3af', fontSize: 13 }}>当前页没有可编辑元素</p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {layers.map(function(layer, i) {
          const isOver = overIdx === i && dragIdx !== i
          const isSubtitle = layer.role === 'subtitle'
          const isSubSelected = isSubtitle && selectedSubIdx === layer.subIdx
          const isGlobal = layer.global

          return (
            <div key={i}>
              {/* 字幕分隔线：在第一个字幕上方 */}
              {i === firstSubIdx && firstSubIdx >= 0 && (
                <div style={{ fontSize: 11, color: '#16a34a', fontWeight: 600, padding: '4px 6px', marginTop: 6, marginBottom: 2, borderBottom: '1px solid #bbf7d0', display: 'flex', alignItems: 'center', gap: 6 }}>
                  📝 字幕
                  <span style={{ fontWeight: 400, color: '#9ca3af' }}>（单击选中底栏 · 双击编辑文字）</span>
                </div>
              )}
              <div
                draggable
                onDragStart={(e) => handleDragStart(e, i)}
                onDragOver={(e) => handleDragOver(e, i)}
                onDrop={(e) => handleDrop(e, i)}
                onDragEnd={handleDragEnd}
                onClick={function () {
                  if (isSubtitle) {
                    onSelectSub(layer.subIdx)
                  } else {
                    send({ type: 'selectLayer', index: i })
                  }
                }}
                onDoubleClick={function () {
                  if (isSubtitle) {
                    onSelectSub(layer.subIdx)
                    send({ type: 'startTextEditOnSubtitle', subIdx: layer.subIdx })
                  } else {
                    send({ type: 'startTextEdit', index: i })
                  }
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 6px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontSize: 12,
                  background: isOver ? '#fef3c7' : (isSubSelected ? '#dcfce7' : (isSubtitle ? '#f0fdf4' : '#f9fafb')),
                  border: isOver ? '2px dashed #C41E24' : (isSubSelected ? '1.5px solid #16a34a' : (isSubtitle ? '1px solid #bbf7d0' : '1px solid #e5e7eb')),
                  opacity: dragIdx === i ? 0.5 : 1,
                  transition: 'all .12s',
                }}
                title={layer.tag + (layer.text ? ' — ' + layer.text : '')}
              >
                <span style={{ color: '#9ca3af', fontSize: 11, minWidth: 20 }}>{i + 1}</span>
                <span style={{ fontSize: 14, flexShrink: 0 }}>
                  {isSubtitle ? '📝' : layer.tag === 'img' ? '🖼' : layer.tag === 'video' ? '🎬' : layer.tag === 'svg' ? '🔷' : '📄'}
                </span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#374151' }}>
                  {layer.text || '<' + layer.tag + '>'}
                </span>
                {isSubtitle && <span style={{ fontSize: 10, color: '#16a34a', background: '#dcfce7', padding: '0 4px', borderRadius: 3, flexShrink: 0 }}>字幕</span>}
                {isGlobal && <span style={{ fontSize: 10, color: '#7c3aed', background: '#ede9fe', padding: '0 4px', borderRadius: 3, flexShrink: 0 }}>全局</span>}
                <span
                  onClick={(e) => { e.stopPropagation(); send({ type: 'toggleLayerLock', index: i }) }}
                  style={{ fontSize: 11, cursor: 'pointer', color: layer.locked ? '#ef4444' : '#d1d5db', opacity: layer.locked ? 1 : 0.4 }}
                  title={layer.locked ? '点击解锁' : '点击锁定'}
                >🔒</span>
                <span
                  onClick={(e) => { e.stopPropagation(); send({ type: 'toggleLayerVisibility', index: i }) }}
                  style={{ fontSize: 11, cursor: 'pointer', color: layer.hidden ? '#9ca3af' : '#d1d5db', opacity: layer.hidden ? 1 : 0.4 }}
                  title={layer.hidden ? '点击显示' : '点击隐藏'}
                >{layer.hidden ? '👁️‍🗨️' : '👁️'}</span>
                <span style={{ fontSize: 11, color: '#d1d5db', cursor: 'grab' }}>⠿</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// 动画面板（inline 模式：直接嵌在底栏绑定按钮后面，非单独弹框）
function AnimPanel({ selected, send, inline }) {
  const [effect, setEffect] = useState('')
  const [duration, setDuration] = useState('')
  const [delay, setDelay] = useState('')
  const [returnSec, setReturnSec] = useState('')

  useEffect(() => {
    setEffect(selected.animEffect || '')
    setDuration(selected.animDuration || '')
    setDelay(selected.animDelay || '')
    setReturnSec(selected.animReturn || '')
  }, [selected])

  function applyAnimAndPreview(overrides) {
    var props = {
      animEffect: overrides && overrides.animEffect != null ? overrides.animEffect : effect,
      animDuration: overrides && overrides.animDuration != null ? overrides.animDuration : duration,
      animDelay: overrides && overrides.animDelay != null ? overrides.animDelay : delay,
      animReturn: overrides && overrides.animReturn != null ? overrides.animReturn : returnSec,
    }
    send({ type: 'setAnimation', props: props })
    setTimeout(function () { send({ type: 'previewAnim' }) }, 30)
  }

  function clearAnim() {
    setEffect(''); setDuration(''); setDelay(''); setReturnSec('')
    send({ type: 'setAnimation', props: {
      animEffect: '', animDuration: '', animDelay: '', animReturn: '', animEasing: '',
    }})
  }

  function nudge(key, delta) {
    var cur = ''
    if (key === 'duration') cur = duration
    else if (key === 'delay') cur = delay
    else if (key === 'return') cur = returnSec
    var v = parseFloat(cur) || 0
    v = Math.round((v + delta) * 10) / 10
    if (v < 0) v = 0
    var nv = String(v)
    if (key === 'duration') setDuration(nv)
    else if (key === 'delay') setDelay(nv)
    else if (key === 'return') setReturnSec(nv)
    var ov = {}
    if (key === 'duration') ov.animDuration = nv
    else if (key === 'delay') ov.animDelay = nv
    else if (key === 'return') ov.animReturn = nv
    applyAnimAndPreview(ov)
  }

  // 底栏 inline 样式：所有控件都在同一行，动画选择框用原生下拉菜单
  if (inline) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        fontSize: 12,
        background: '#111827',
        border: '1px solid #374151',
        borderRadius: 6,
        padding: '4px 10px',
      }}>
        <span style={{ color: '#fbbf24', fontWeight: 700 }}>动画</span>
        <select
          value={effect}
          onChange={(e) => { setEffect(e.target.value); applyAnimAndPreview({ animEffect: e.target.value }) }}
          style={{
            background: '#1f2937',
            color: '#fff',
            border: '1px solid #4b5563',
            borderRadius: 4,
            padding: '4px 8px',
            fontSize: 12,
          }}
        >
          {ANIM_EFFECTS.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>

        <span style={{ color: '#9ca3af' }}>时长</span>
        <StepperInput
          value={duration || '0'}
          onChange={(v) => nudge('duration', parseFloat(v) - (parseFloat(duration) || 0))}
          step={0.5}
          min={0}
          width={78}
          dark
        />

        <span style={{ color: '#9ca3af' }}>延迟</span>
        <StepperInput
          value={delay || '0'}
          onChange={(v) => nudge('delay', parseFloat(v) - (parseFloat(delay) || 0))}
          step={0.5}
          min={0}
          width={78}
          dark
        />

        <span style={{ color: '#9ca3af' }}>恢复</span>
        <StepperInput
          value={returnSec || '0'}
          onChange={(v) => nudge('return', parseFloat(v) - (parseFloat(returnSec) || 0))}
          step={0.5}
          min={0}
          width={78}
          dark
        />

        <button onClick={clearAnim} style={timelineBtn('#7f1d1d')}>清除动画</button>
      </div>
    )
  }

  return null
}
const inp = {
  width: '100%',
  boxSizing: 'border-box',
  height: 30,
  padding: '0 10px',
  border: '1px solid #e5e7eb',
  borderRadius: 10,
  boxShadow: '0 2px 6px rgba(0,0,0,0.10)',
  fontSize: 13,
  fontFamily: 'inherit',
  background: '#fff',
  color: '#1f2937',
  outline: 'none',
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

// 从脚本数组中提取 subtitles / slideTimings（用括号匹配，避免正则无法处理嵌套）
function extractBracketContent(str, startIdx) {
  let depth = 0
  for (let i = startIdx; i < str.length; i++) {
    if (str[i] === '[') depth++
    else if (str[i] === ']') {
      depth--
      if (depth === 0) return str.slice(startIdx, i + 1)
    }
  }
  return null
}

function extractSubtitleData(scripts) {
  for (const script of scripts) {
    const content = script.replace(/^<script>/, '').replace(/<\/script>$/, '')
    if (!content.includes('subtitles') || !content.includes('slideTimings')) continue
    const subMatch = content.match(/const\s+subtitles\s*=\s*/)
    const tmMatch = content.match(/const\s+slideTimings\s*=\s*/)
    if (!subMatch || !tmMatch) continue
    const subStart = content.indexOf('[', subMatch.index + subMatch[0].length)
    const tmStart = content.indexOf('[', tmMatch.index + tmMatch[0].length)
    if (subStart < 0 || tmStart < 0) continue
    const subContent = extractBracketContent(content, subStart)
    const tmContent = extractBracketContent(content, tmStart)
    if (!subContent || !tmContent) continue
    try {
      const subtitles = JSON.parse(subContent)
      const slideTimings = JSON.parse(tmContent)
      return { subtitles, slideTimings }
    } catch (e) {
      try {
        const subtitles = new Function('return ' + subContent)()
        const slideTimings = new Function('return ' + tmContent)()
        return { subtitles, slideTimings }
      } catch (e2) {}
    }
  }
  return null
}

// 生成注入字幕数据的 <script> 标签
function buildSubtitleDataScript(scripts) {
  const data = extractSubtitleData(scripts)
  if (!data) return ''
  return '<script>window.__ztSubtitles=' + JSON.stringify(data.subtitles) +
    ';window.__ztSlideTimings=' + JSON.stringify(data.slideTimings) + ';</script>'
}

// 底部时间轴面板
function TimelinePanel({ subtitles, selectedSubIdx, onSelectSub, subBindingMode, bindingTarget, onPrevPage, onNextPage, onBind, onUnbind, onConfirm, onCancelBind, current, total, selected, send }) {
  const maxTime = subtitles.length > 0
    ? Math.max.apply(null, subtitles.map(function (s) { return s.end || 5 }))
    : 10
  const isGlobal = subtitles.length > 0 && subtitles[0].source === 'global'
  const selectedSub = selectedSubIdx >= 0 ? subtitles[selectedSubIdx] : null
  const canUnbind = (selectedSub && selectedSub.boundTo && selectedSub.source === 'dom') || !!selected

  return (
    <div
      style={{
        background: '#1f2937',
        borderTop: '1px solid #374151',
        padding: '8px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        userSelect: 'none',
      }}
    >
      {/* 绑定操作按钮（页面导航已移至上方页面预览 tab 条） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {!subBindingMode ? (
          <>
            <button
              onClick={function () { onPrevPage('prev') }}
              disabled={selectedSubIdx < 0}
              style={timelineBtn(selectedSubIdx >= 0 ? '#4b5563' : '#374151')}
              title="字幕移动到上一页"
            >
              ⬆ 字幕到上一页
            </button>
            <button
              onClick={function () { onNextPage('next') }}
              disabled={selectedSubIdx < 0}
              style={timelineBtn(selectedSubIdx >= 0 ? '#4b5563' : '#374151')}
              title="字幕移动到下一页"
            >
              字幕到下一页 ⬇
            </button>
            <button
              onClick={onBind}
              disabled={selectedSubIdx < 0 || isGlobal}
              style={timelineBtn(selectedSubIdx >= 0 && !isGlobal ? '#C41E24' : '#374151')}
              title={isGlobal ? '全局字幕不支持绑定' : '字幕绑定到画面元素'}
            >
              🔗 绑定
            </button>
              <button
                onClick={onUnbind}
                disabled={!canUnbind}
                style={timelineBtn(canUnbind ? '#7f1d1d' : '#374151')}
                title="解除当前字幕与元素的绑定关系"
              >
                ⛓ 解除绑定
              </button>
          </>
        ) : (
          <>
            <span style={{ fontSize: 12, color: '#fbbf24' }}>
              点击画布中的元素以绑定{bindingTarget ? '（已选: ' + (bindingTarget.tag || '') + ' - ' + (bindingTarget.text || '') + '）' : ''}
            </span>
            <button onClick={onConfirm} disabled={!bindingTarget} style={timelineBtn(bindingTarget ? '#0F6E56' : '#374151')}>
              ✅ 确认
            </button>
            <button onClick={onCancelBind} style={timelineBtn('#7f1d1d')}>
              ✕ 取消
            </button>
          </>
        )}
        {selected && !subBindingMode && (
          <AnimPanel selected={selected} send={send} inline />
        )}
      </div>

      {/* 时间轴条 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: '#9ca3af', minWidth: 24 }}>0s</span>
        <div
          style={{
            flex: 1,
            height: 32,
            background: '#111827',
            borderRadius: 4,
            position: 'relative',
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          {subtitles.length === 0 && (
            <span style={{ fontSize: 11, color: '#4b5563', paddingLeft: 8 }}>
              当前页没有字幕（需 data-zt-role="subtitle" 元素，或页面脚本中的 subtitles/slideTimings 数组）
            </span>
          )}
          {subtitles.map(function (sub, i) {
            var left = (sub.start / maxTime) * 100
            var width = ((sub.end - sub.start) / maxTime) * 100
            if (width < 3) width = 3
            var isSelected = i === selectedSubIdx
            var isBound = sub.boundTo && sub.boundTo.length > 0
            return (
              <div
                key={i}
                onClick={function () { onSelectSub(isSelected ? -1 : i) }}
                onDoubleClick={function () { onSelectSub(i); send({ type: 'startTextEditOnSubtitle', subIdx: i }) }}
                style={{
                  position: 'absolute',
                  left: left + '%',
                  width: width + '%',
                  height: isSelected ? 28 : 22,
                  background: isSelected ? '#C41E24' : (isBound ? '#0F6E56' : (sub.source === 'global' ? '#b45309' : '#4b5563')),
                  borderRadius: 3,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                  color: '#fff',
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                  padding: '0 4px',
                  boxSizing: 'border-box',
                  border: isSelected ? '1.5px solid #fff' : 'none',
                  transition: 'height .1s',
                  zIndex: isSelected ? 2 : 1,
                }}
                title={sub.text + (isBound ? ' (已绑定)' : '')}
              >
                {sub.text}
              </div>
            )
          })}
        </div>
        <span style={{ fontSize: 11, color: '#9ca3af', minWidth: 24 }}>{maxTime}s</span>
      </div>

    </div>
  )
}

function timelineBtn(bg) {
  return {
    background: bg,
    color: '#fff',
    border: 'none',
    padding: '5px 10px',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
    whiteSpace: 'nowrap',
  }
}

// 画布右键上下文菜单
function ContextMenu({ menu, zoom, iframeRef, selCount, send, onClose, clipCount }) {
  const [sub, setSub] = useState(null) // 'align' | null 二级菜单
  const [subStyle, setSubStyle] = useState(null) // 对齐子菜单定位 { left, top, dir }
  const [hoverIdx, setHoverIdx] = useState(-1) // 当前悬浮菜单项索引（高亮）
  const [measured, setMeasured] = useState({ h: 0, subH: 0 }) // 主菜单/二级菜单实际渲染高度
  const alignRef = useRef(null) // 对齐行 ref，用于测量
  const subRef = useRef(null) // 对齐二级菜单 ref，用于测量
  const ref = useRef(null)
  useLayoutEffect(() => {
    const nm = { h: ref.current ? ref.current.offsetHeight : 0, subH: subRef.current ? subRef.current.offsetHeight : 0 }
    setMeasured(nm)
  }, [menu, sub, subStyle])
  useEffect(() => {
    if (!menu) return
    setHoverIdx(-1)
    setSub(null)
    setSubStyle(null)
    function onDocDown(e) {
      if (ref.current && ref.current.contains(e.target)) return
      onClose()
      setSub(null)
      setSubStyle(null)
    }
    function onEsc(e) {
      if (e.key === 'Escape') {
        onClose()
        setSub(null)
        setSubStyle(null)
      }
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('contextmenu', onDocDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('contextmenu', onDocDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [menu, onClose])

  if (!menu) return null

  // 将 iframe 内的坐标换算到父页面（iframe 被 transform:scale(zoom) 缩放）
  const r = iframeRef.current && iframeRef.current.getBoundingClientRect ? iframeRef.current.getBoundingClientRect() : null
  const px = r ? r.left + menu.x * zoom : menu.x
  const py = r ? r.top + menu.y * zoom : menu.y
  const menuW = 190
  // 主菜单高度：越界时向上弹出（顶部留 8px，底部留 4px）
  const menuH = measured.h || 360
  const left = Math.min(px, Math.max(8, window.innerWidth - menuW - 4))
  const top = Math.min(py, Math.max(8, window.innerHeight - menuH - 4))

  const editable = !!menu.editable
  // 打开对齐二级菜单：根据可用空间自动选择展开方向（右/左、下/上）
  function openAlignSub() {
    if (selCount < 2) { setSub(null); setSubStyle(null); return }
    const m = ref.current && ref.current.getBoundingClientRect()
    const a = alignRef.current && alignRef.current.getBoundingClientRect()
    const subW = menuW
    // 二级菜单高度：优先用实测值，未渲染时按每项高 31px 估算
    const subH = (measured.subH || (ALIGNS.length * 31 + 9))
    let sx = m ? m.right - 4 : 0
    let dir = 'right'
    if (sx + subW > window.innerWidth - 4) {
      sx = (m ? m.left : 0) - subW + 4
      dir = 'left'
    }
    let sy = a ? a.top : 0
    // 底部越界向上弹出；顶部越界则下移
    if (sy + subH > window.innerHeight - 4) sy = window.innerHeight - 4 - subH
    if (sy < 4) sy = Math.min(a ? a.top : 4, 4)
    setSubStyle({ left: Math.round(sx), top: Math.round(sy), dir })
    setSub('align')
  }

  const item = (label, action, disabled, danger, idx) => (
    <div
      onClick={() => {
        if (disabled) return
        action()
        onClose()
        setSub(null)
      }}
      onMouseEnter={() => { setHoverIdx(idx); setSub(null) }}
      style={{
        padding: '7px 12px',
        fontSize: 13,
        color: disabled ? '#c0c4cc' : danger ? '#C41E24' : '#1f2937',
        cursor: disabled ? 'default' : 'pointer',
        whiteSpace: 'nowrap',
        background: hoverIdx === idx && !disabled ? 'rgba(196,30,36,.10)' : 'transparent',
        borderLeft: hoverIdx === idx && !disabled ? '3px solid #C41E24' : '3px solid transparent',
      }}
    >
      {label}
    </div>
  )

  const sep = () => <div style={{ height: 1, background: '#e5e7eb', margin: '4px 0' }} />

  const run = (action) => { send({ type: action }) }

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left,
        top,
        width: menuW,
        background: '#fff',
        border: '1px solid #d1d5db',
        borderRadius: 8,
        boxShadow: '0 6px 20px rgba(0,0,0,.15)',
        zIndex: 2147483600,
        padding: '4px 0',
        fontFamily: 'inherit',
      }}
    >
      {item('复制', () => run('copy'), !editable, false, 0)}
      {item('剪切', () => run('cut'), !editable, false, 1)}
      {item('粘贴', () => send({ type: 'paste', x: menu.x, y: menu.y }), clipCount<=0, false, 2)}
      {item('删除', () => run('delete'), !editable, true, 200)}
      {sep()}
      {item('置顶', () => send({ type: 'layer', mode: 'top' }), !editable, false, 3)}
      {item('上移', () => send({ type: 'layer', mode: 'up' }), !editable, false, 4)}
      {item('下移', () => send({ type: 'layer', mode: 'down' }), !editable, false, 5)}
      {item('置底', () => send({ type: 'layer', mode: 'bottom' }), !editable, false, 6)}
      {sep()}
      {item('组合', () => run('group'), !editable || selCount < 2, false, 7)}
      {item('取消组合', () => run('ungroup'), !editable, false, 8)}
      {item(menu.anyLocked ? '解锁' : '锁定', () => run('toggleLock'), !editable, false, 9)}
      {sep()}
      <div
        ref={alignRef}
        style={{ position: 'relative' }}
        onMouseEnter={openAlignSub}
        onMouseLeave={() => { setSub(null); setSubStyle(null) }}
      >
        <div
          style={{
            padding: '7px 12px',
            fontSize: 13,
            color: selCount >= 2 ? '#1f2937' : '#c0c4cc',
            cursor: selCount >= 2 ? 'pointer' : 'default',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          对齐
          <span style={{ color: '#9ca3af' }}>{subStyle && subStyle.dir === 'left' ? '‹' : '›'}</span>
        </div>
        {sub === 'align' && subStyle && (
          <div
            ref={subRef}
            style={{
              position: 'fixed',
              left: subStyle.left,
              top: subStyle.top,
              width: menuW,
              background: '#fff',
              border: '1px solid #d1d5db',
              borderRadius: 8,
              boxShadow: '0 6px 20px rgba(0,0,0,.15)',
              zIndex: 2147483601,
              padding: '4px 0',
            }}
            onMouseLeave={() => { setSub(null); setSubStyle(null) }}
          >
            {ALIGNS.map(([mode, label], si) => (
              <div
                key={mode}
                onClick={() => {
                  send({ type: 'align', mode })
                  onClose()
                  setSub(null)
                  setSubStyle(null)
                }}
                onMouseEnter={() => setHoverIdx(100 + si)}
                style={{
                  padding: '7px 12px',
                  fontSize: 13,
                  color: '#1f2937',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  background: hoverIdx === 100 + si ? 'rgba(196,30,36,.10)' : 'transparent',
                  borderLeft: hoverIdx === 100 + si ? '3px solid #C41E24' : '3px solid transparent',
                  boxSizing: 'border-box',
                }}
              >
                {label}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
