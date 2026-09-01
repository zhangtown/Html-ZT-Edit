// HTML-ZtEdit · OBS 录制后端（系统级录屏，全自动）
//
// 把「捕获 + 编码」整体交给 OBS（DXGI 抓窗口 → 硬件编码 NVENC/QSV/x264），
// Electron 主进程只经 obs-websocket 发「开始/停止」，不参与任何像素与音频处理。
// 这是清晰度的上限路线：录的是 ztEdit 真实窗口（播放时已全屏），同 Win+Shift+R 同级、
// 上限更高，且声音走 Windows 系统音频回路，天然带声。
//
// 一键 = 全自动，UI 上只有一个「● OBS 录制」按钮。点下去控制器依次做完：
//   1) 建/复用专用场景「ZT-录制」
//   2) 自动从 OBS 的窗口列表里认出 ztEdit 主窗口，建/更新「窗口捕获」源并铺满画布
//   3) 把 OBS 画布对齐到全屏尺寸（否则会被降采样，白丢清晰度）
//   4) 场景与全局都没有音源时，自动补一个「桌面音频」源
//   5) 切到该场景、把录制目录设成当前 HTML 所在目录、起录
// 任何一步失败都直接把根因回传，不再让用户在 OBS 里手工配。
//
// 设计红线（都是实测踩过的坑）：
//   - 场景名/源名一律不硬编码成"用户环境里可能有也可能没有"的东西，只建自己专用的；
//     且建之前先向 OBS 查真实列表（OBS 允许同名场景，直接 CreateScene 会建出「ZT-录制 1」）。
//   - 「窗口捕获」源必须存在，否则 StartRecord 照样返回成功，成片全是黑屏。
//   - 铺满画布用 bounds(OBS_BOUNDS_SCALE_INNER)，不需要知道源原始尺寸，
//     也不会出现"只录到左上角一部分"。
//
// 依赖 obs-websocket-js 用 lazy require：本机没装时主进程照常启动，
// 只在连接 OBS 时才报错，不会因缺依赖拖垮编辑器启动。

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn, spawnSync } = require('child_process')

const SCENE_NAME = 'ZT-录制'                 // 全自动维护的专用场景
const WIN_SOURCE = 'zt-window'               // 窗口捕获源（指向 ztEdit 主窗口）
const AUDIO_SOURCE = 'zt-desktop-audio'      // 场景/全局都没音源时自动补的「桌面音频」

// 场景里能出画面的源类型（一个都没有 → 录出来是黑屏）
const VIDEO_KINDS = [
  'window_capture', 'display_capture', 'monitor_capture', 'game_capture',
  'browser_source', 'dshow_input', 'image_source', 'ffmpeg_source',
  'vlc_source', 'slideshow', 'color_source',
]
// 能出声的源类型（一个都没有 → 成片没声音）
const AUDIO_KINDS = [
  'wasapi_output_capture', 'wasapi_input_capture', 'wasapi_process_output_capture', 'browser_source',
]
// 能录到「系统/应用播放出来的声音」的源类型（页面 <audio> 的声音只走这几类）
const DESKTOP_AUDIO_KINDS = ['wasapi_output_capture', 'wasapi_process_output_capture']

let obs = null            // OBSWebSocket 实例（单例）
let connected = false
let lastOutputPath = ''   // 起录时 OBS 回传的准确输出路径（stop 时优先用它，比扫目录可靠）
let lastOutputDir = ''    // 起录时的输出目录（stop 时扫目录兜底用）

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function loadObsConfig() {
  const port = process.env.OBS_PORT
  const password = process.env.OBS_PASSWORD
  if (password && port) return { port: parseInt(port, 10), password: password }
  const cfg = path.join(os.homedir(), 'AppData/Roaming/obs-studio/plugin_config/obs-websocket/config.json')
  try {
    const j = JSON.parse(fs.readFileSync(cfg, 'utf8'))
    return { port: j.server_port || 4455, password: j.server_password || '' }
  } catch (e) {
    return { port: 4455, password: '' }
  }
}

function getObs() {
  if (obs) return obs
  // lazy require：缺依赖时只有连接阶段才抛错，不影响编辑器启动
  const pkg = require('obs-websocket-js')
  const OBSWebSocket = pkg.OBSWebSocket || pkg.default || pkg
  obs = new OBSWebSocket()
  return obs
}

// ---------------------------------------------------------------------------
// OBS 可执行文件定位 + 自动拉起
// ---------------------------------------------------------------------------

// 定位 obs64.exe：环境变量 > 上次落盘的 JSON > 搜常见安装路径（仅首次搜，之后固化）。
// 一旦找到就写进 Windows 用户环境变量（setx 持久化）+ 落盘，下一次启动直接命中，
// 不再做目录搜索 —— 即"轮询一次，之后不用再找"。
let obsExeCache = ''

const OBS_SEARCH_PATHS = [
  'C:/Program Files/obs-studio/bin/64bit/obs64.exe',
  'C:/Program Files (x86)/obs-studio/bin/64bit/obs64.exe',
  '%ProgramFiles%/obs-studio/bin/64bit/obs64.exe',
  '%ProgramFiles(x86)%/obs-studio/bin/64bit/obs64.exe',
  '%LOCALAPPDATA%/Programs/obs-studio/bin/64bit/obs64.exe',
  'C:/obs-studio/bin/64bit/obs64.exe',
]

function expandEnvVars(p) {
  return p
    .replace(/%ProgramFiles\(x86\)%/gi, process.env['ProgramFiles(x86)'] || '')
    .replace(/%ProgramFiles%/gi, process.env.ProgramFiles || '')
    .replace(/%LOCALAPPDATA%/gi, process.env.LOCALAPPDATA || '')
}

function obsStorePath() {
  try {
    const { app } = require('electron')
    return path.join(app.getPath('userData'), 'obs-exe.json')
  } catch (e) {
    return path.join(os.homedir(), '.ztedit-obs-exe.json')
  }
}

function loadExeFromStore() {
  try {
    const j = JSON.parse(fs.readFileSync(obsStorePath(), 'utf8'))
    if (j && j.exe && fs.existsSync(j.exe)) return j.exe
  } catch (e) {}
  return ''
}

// 把找到的 exe 固化：①本进程立即生效 ②setx 写进 Windows 用户环境变量（后续进程继承）
// ③落盘 JSON 兜底（防止 setx 因组策略/权限失效）。
function persistExe(exe) {
  process.env.OBS_EXE = exe
  obsExeCache = exe
  try { spawnSync('setx', ['OBS_EXE', exe], { windowsHide: true }) } catch (e) {}
  try {
    fs.writeFileSync(obsStorePath(), JSON.stringify({ exe, savedAt: new Date().toISOString() }), 'utf8')
  } catch (e) {}
}

async function resolveObsExe() {
  // 1) 环境变量（setx 固化后，下一次启动直接命中，无需搜索）
  const envExe = process.env.OBS_EXE || obsExeCache
  if (envExe && fs.existsSync(envExe)) return { ok: true, exe: envExe, from: 'env' }
  // 2) 上次落盘的 JSON
  const stored = loadExeFromStore()
  if (stored) {
    persistExe(stored) // 顺手同步回环境变量
    return { ok: true, exe: stored, from: 'store' }
  }
  // 3) 首次：搜索常见路径，找到即固化，下次不再搜
  for (const raw of OBS_SEARCH_PATHS) {
    const p = expandEnvVars(raw)
    if (p && fs.existsSync(p)) {
      persistExe(p)
      return { ok: true, exe: p, from: 'search' }
    }
  }
  return {
    ok: false,
    error:
      '未找到 OBS 安装（已搜过常见路径）。\n请先安装 OBS Studio，' +
      '或在系统环境变量里设置 OBS_EXE 指向 obs64.exe（例如 C:/Program Files/obs-studio/bin/64bit/obs64.exe）。',
  }
}

// OBS 进程是否已在跑（避免重复拉起）。仅 Windows 有意义。
function isObsRunning() {
  if (process.platform !== 'win32') return false
  try {
    const out = spawnSync('tasklist', ['/FI', 'IMAGENAME eq obs64.exe', '/NH'], { windowsHide: true })
    const s = out.stdout ? out.stdout.toString() : ''
    return /obs64\.exe/i.test(s)
  } catch (e) {
    return false
  }
}

// 确保 OBS 已启动并建立 websocket 连接：
//   已连 → 直接返回；未连 → 找到 exe 自动拉起 → 轮询连接直到握手成功（超时则报错）。
// 这样点「● OBS 录制」时即便 OBS 没开，也会自动启动，真正一步到位。
async function ensureOBSRunning({ timeoutMs = 30000, pollMs = 1000 } = {}) {
  if (connected && obs) return { ok: true, reused: true }

  const first = await connect()
  if (first.ok) return first

  // 没连上：多半是 OBS 没跑。先确认没有 OBS 进程在跑，避免重复拉起。
  const ex = await resolveObsExe()
  if (!ex.ok) return ex

  if (!isObsRunning()) {
    try {
      const child = spawn(ex.exe, [], {
        cwd: path.dirname(ex.exe),
        detached: true, // 独立于 ztEdit，关掉编辑器 OBS 也不退出
        stdio: 'ignore',
        windowsHide: false,
      })
      child.unref()
    } catch (e) {
      return { ok: false, error: '启动 OBS 失败：' + ((e && e.message) || e) }
    }
  }

  // 轮询连接（OBS 启动 + websocket 就绪需要几秒）
  const t0 = Date.now()
  let lastErr = first.error
  while (Date.now() - t0 < timeoutMs) {
    await wait(pollMs)
    const cr = await connect()
    if (cr.ok) return { ok: true, launched: true, exe: ex.exe }
    lastErr = cr.error
  }
  return {
    ok: false,
    error:
      '已尝试启动 OBS，但 websocket 在超时时间内一直连不上。\n' + lastErr +
      '\n请确认 OBS 设置里 obs-websocket 已启用（工具 → obs-websocket 设置），且端口/密码与读取的一致。',
  }
}

async function connect() {
  if (connected && obs) return { ok: true, reused: true }
  const cfg = loadObsConfig()
  const o = getObs()
  const url = 'ws://127.0.0.1:' + cfg.port
  try {
    await o.connect(url, cfg.password || undefined)
    connected = true
    return { ok: true, url, port: cfg.port }
  } catch (e) {
    connected = false
    obs = null // 失败则丢弃旧实例，下一次 connect 建新的，避免轮询时复用坏连接
    const msg = (e && e.message) ? e.message : String(e)
    return {
      ok: false,
      error:
        '无法连接 OBS：' + msg +
        '\n请确认：1) OBS 已启动（改过配置需完全退出重开）；2) 工具→obs-websocket 设置 已启用；' +
        '3) 端口/密码正确（可用环境变量 OBS_PORT / OBS_PASSWORD 覆盖）',
    }
  }
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

// 建/复用场景。先查真实列表再建——OBS 允许同名场景存在，
// 直接 CreateScene 会在第二次跑时建出「ZT-录制 1」，源全跑到新场景里去，
// 而录制时切的还是第一个（空的那个）→ 黑屏。
async function ensureScene(name) {
  const o = getObs()
  const s = await o.call('GetSceneList')
  const names = (s.scenes || []).map((x) => x.sceneName || x.name).filter(Boolean)
  if (names.indexOf(name) >= 0) return false
  try {
    await o.call('CreateScene', { sceneName: name })
    return true
  } catch (e) {
    // 可能只是并发建过：再查一次确认
    const s2 = await o.call('GetSceneList')
    const n2 = (s2.scenes || []).map((x) => x.sceneName || x.name).filter(Boolean)
    if (n2.indexOf(name) >= 0) return false
    throw new Error(`创建场景「${name}」失败：` + ((e && e.message) || e))
  }
}

// ---------------------------------------------------------------------------
// 窗口识别 + 窗口捕获源
// ---------------------------------------------------------------------------

// OBS 能捕获的窗口列表。itemValue 形如 "标题:窗口类:可执行文件名"，
// 这个字符串是唯一能喂回 SetInputSettings 的标识，绝不能自己拼。
//
// 关键坑（用户实测踩过）：obs-websocket 5.7+ 的 GetInputPropertiesListPropertyItems
// 不再接受 inputKind，必须传一个已存在的 input 的 inputName（配合可选 propertyName）。
// 所以这里先建一个临时 window_capture 输入当载体，枚举完立即删掉——
// 否则会报 "must contain at least one of: inputName ... or inputUuid"。
async function listWindows() {
  const o = getObs()
  const r = await connect()
  if (!r.ok) return r
  const tmpName = 'zt-tmp-wincap-' + Date.now()
  let created = false
  try {
    await o.call('CreateInput', {
      sceneName: SCENE_NAME,
      inputName: tmpName,
      inputKind: 'window_capture',
      inputSettings: {},
    })
    created = true
    const p = await o.call('GetInputPropertiesListPropertyItems', {
      inputName: tmpName,
      propertyName: 'window',
    })
    const items = (p.propertyItems || [])
      .map((x) => ({ name: x.itemName || '', value: x.itemValue || '' }))
      .filter((x) => x.value)
    return { ok: true, windows: items }
  } catch (e) {
    return { ok: false, error: '读取可捕获窗口列表失败：' + ((e && e.message) || e) }
  } finally {
    if (created) {
      try { await o.call('RemoveInput', { inputName: tmpName }) } catch (e) {}
    }
  }
}

// 自动认出 ztEdit 主窗口：以主进程传来的真实窗口标题为准，逐级放宽。
// 全部落空时把 OBS 实际看到的窗口名列出来，用户一眼能看出是标题变了还是 OBS 没刷新。
async function autoPickWindow(title) {
  const r = await listWindows()
  if (!r.ok) return r
  const list = r.windows || []
  if (!list.length) return { ok: false, error: 'OBS 返回的可捕获窗口列表为空（OBS 可能刚启动，或运行在无窗口采集权限的会话里）。' }
  const t = String(title || '').trim()
  const score = (w) => {
    const n = w.name || ''
    const v = w.value || ''
    if (t && n === t) return 0                                  // 标题完全一致
    if (t && v.indexOf(t) >= 0) return 1                        // 标识串里含标题
    if (t && n.indexOf(t) >= 0) return 2                        // 窗口名包含标题
    if (/html-ztedit|ztedit|zt-edit/i.test(n)) return 3         // 名字像 ztEdit
    if (/electron\.exe/i.test(v)) return 4                      // Electron 进程
    return 99
  }
  let best = null
  let bestScore = 99
  for (const w of list) {
    const s = score(w)
    if (s < bestScore) { bestScore = s; best = w }
  }
  if (!best) {
    return {
      ok: false,
      error:
        `没能在 OBS 的窗口列表里认出 ztEdit 主窗口（预期标题含「${t || '（未知）'}」）。\n` +
        `OBS 现在能看到的窗口：${list.slice(0, 12).map((w) => w.name).join('、')}`,
    }
  }
  return { ok: true, value: best.value, name: best.name, score: bestScore }
}

// 建/更新「窗口捕获」源并铺满画布 —— 这就是"把画面送进 OBS 场景"的环节。
// 用 bounds 铺满：不需要知道源原始尺寸，也不会出现"只录到左上角一部分"。
async function ensureWindowCapture(sceneName, windowVal) {
  const o = getObs()
  let exists = false
  try {
    const si = await o.call('GetSceneItemId', { sceneName, sourceName: WIN_SOURCE })
    exists = si.sceneItemId != null
  } catch (e) {
    exists = false
  }

  const settings = { window: windowVal, capture_cursor: false }
  if (!exists) {
    await o.call('CreateInput', {
      sceneName,
      inputName: WIN_SOURCE,
      inputKind: 'window_capture',
      inputSettings: settings,
      setVisible: true,
    })
  } else {
    await o.call('SetInputSettings', { inputName: WIN_SOURCE, inputSettings: settings })
  }

  try {
    const v = await o.call('GetVideoSettings')
    const si = await o.call('GetSceneItemId', { sceneName, sourceName: WIN_SOURCE })
    if (si.sceneItemId != null) {
      await o.call('SetSceneItemTransform', {
        sceneName,
        sceneItemId: si.sceneItemId,
        sceneItemTransform: {
          positionX: 0,
          positionY: 0,
          boundsType: 'OBS_BOUNDS_SCALE_INNER',
          boundsAlignment: 0,
          boundsWidth: v.baseWidth,
          boundsHeight: v.baseHeight,
        },
      })
    }
  } catch (e) {
    /* 变换失败不致命：源已在场景里，最多位置/尺寸不完美 */
  }
  return true
}

// 读取源在 OBS 里的真实像素尺寸（GetSceneItemTransform 回传的 sourceWidth/Height）。
// 画布比源大 → 放大（糊）；比源小 → 缩小（丢清晰度）；只有 1:1 最锐利。
// 不能拿主进程传来的显示器尺寸当画布——捕获的是窗口，窗口通常比显示器小。
async function getSourceSize(sceneName, sourceName) {
  const o = getObs()
  try {
    const si = await o.call('GetSceneItemId', { sceneName, sourceName })
    if (si.sceneItemId == null) return null
    const t = await o.call('GetSceneItemTransform', { sceneName, sceneItemId: si.sceneItemId })
    const tr = t.sceneItemTransform || {}
    const w = tr.sourceWidth || 0
    const h = tr.sourceHeight || 0
    if (!w || !h) return null
    return { width: Math.round(w), height: Math.round(h) }
  } catch (e) {
    return null
  }
}

// ---------------------------------------------------------------------------
// 音频
// ---------------------------------------------------------------------------

// OBS 录制的是混音总输出，只要 profile 里存在任意一个音频输入就会入混，
// 不必挂在要录的场景下。所以这里查的是全局输入列表。
async function hasAnyAudio() {
  const o = getObs()
  try {
    const l = await o.call('GetInputList')
    return (l.inputs || []).some((i) => AUDIO_KINDS.indexOf(i.inputKind) >= 0)
  } catch (e) {
    return false
  }
}

// 只认「能录到系统播放声音」的音源：桌面音频 / 应用音频捕获。
//
// 坑（用户实测"成片完全没声音"）：绝不能用 hasAnyAudio() 当放行条件。
// OBS 默认配置里往往已有一个麦克风（wasapi_input_capture），于是"存在任意音源"为真，
// 就不补桌面音频了 —— 但麦克风录的是人声，页面 <audio> 的声音走的是系统回放，
// 只有 wasapi_output_capture（桌面音频）才抓得到，结果就是成片彻底无声。
async function hasDesktopAudio() {
  const o = getObs()
  try {
    const l = await o.call('GetInputList')
    return (l.inputs || []).some((i) => DESKTOP_AUDIO_KINDS.indexOf(i.inputKind) >= 0)
  } catch (e) {
    return false
  }
}

// 一个音源都没有 → 自动补「桌面音频」（抓 Windows 系统回放，页面里 <audio> 的声音就在这里面）。
// 用户若已在 OBS 配过桌面音频/麦克风，这里什么都不会加。
async function ensureDesktopAudio(sceneName) {
  const o = getObs()
  let exists = false
  try {
    const l = await o.call('GetInputList')
    exists = (l.inputs || []).some((i) => i.inputName === AUDIO_SOURCE)
  } catch (e) {
    exists = false
  }
  if (!exists) {
    try {
      await o.call('CreateInput', {
        sceneName,
        inputName: AUDIO_SOURCE,
        inputKind: 'wasapi_output_capture',
        inputSettings: {},
        setVisible: true,
      })
      // 新建的音源可能被静音/音量 0 —— 不解掉照样录不出声音
      try { await o.call('SetInputMute', { inputName: AUDIO_SOURCE, inputMuted: false }) } catch (e) {}
      return 'added'
    } catch (e) {
      throw new Error('创建「桌面音频」源失败：' + ((e && e.message) || e))
    }
  }
  try { await o.call('SetInputMute', { inputName: AUDIO_SOURCE, inputMuted: false }) } catch (e) {}
  // 源已存在但不在本场景 → 挂进来（音源挂在场景里才会随场景激活）
  try {
    const si = await o.call('GetSceneItemId', { sceneName, sourceName: AUDIO_SOURCE })
    if (si.sceneItemId == null) throw new Error('not in scene')
  } catch (e) {
    try {
      await o.call('CreateSceneItem', { sceneName, sourceName: AUDIO_SOURCE, setVisible: true })
    } catch (e2) { /* 挂不进去也不致命，全局音源照样入混 */ }
  }
  return 'exists'
}

// ---------------------------------------------------------------------------
// 体检 / 画布
// ---------------------------------------------------------------------------

async function sceneHealth(sceneName) {
  const o = getObs()
  const list = ((await o.call('GetSceneItemList', { sceneName })).sceneItems) || []
  const kinds = {}
  try {
    const ins = await o.call('GetInputList')
    for (const it of ins.inputs || []) kinds[it.inputName] = it.inputKind
  } catch (e) { /* 拿不到类型表就退化成 unknown，只影响提示准确度 */ }
  const items = list.map((it) => {
    const n = it.sourceName || ''
    return { name: n, kind: kinds[n] || it.sourceKind || 'unknown', enabled: it.sceneItemEnabled !== false }
  })
  const hasVideo = items.some((f) => f.enabled && VIDEO_KINDS.indexOf(f.kind) >= 0)
  const hasAudio = items.some((f) => f.enabled && AUDIO_KINDS.indexOf(f.kind) >= 0)
  const summary = items.length ? items.map((f) => `${f.name}(${f.kind})`).join('、') : '（空，一个源都没有）'
  return { hasVideo, hasAudio, items, summary }
}

// 画布尺寸对齐全屏尺寸：OBS 画布小于窗口时，捕获画面会被降采样，清晰度白丢。
// 只改分辨率，不动帧率（帧率是用户在 OBS 里长期配置好的，不该被工具覆盖）。
async function fitVideo(width, height) {
  const o = getObs()
  if (!width || !height) return null
  const v = await o.call('GetVideoSettings')
  if (v.baseWidth === width && v.baseHeight === height && v.outputWidth === width && v.outputHeight === height) {
    return null
  }
  await o.call('SetVideoSettings', {
    baseWidth: width,
    baseHeight: height,
    outputWidth: width,
    outputHeight: height,
  })
  await wait(400) // 画布重建需要一拍，紧接着建源/起录会拿到旧尺寸
  return `${v.baseWidth}×${v.baseHeight} → ${width}×${height}`
}

// ---------------------------------------------------------------------------
// 起停
// ---------------------------------------------------------------------------

// 开始录制。opts:
//   { outdir, windowTitle, width, height, autoFit }
//   outdir 必填——成片直接落在当前编辑的 HTML 所在目录。
async function start(opts) {
  const a = opts || {}
  // 连接不上就自动拉起 OBS（首次会搜路径并固化到 OBS_EXE 环境变量，下次免搜）
  const r0 = await ensureOBSRunning()
  if (!r0.ok) return r0
  const o = getObs()

  const outdir = a.outdir ? path.resolve(a.outdir) : ''
  if (!outdir) return { ok: false, error: '没有拿到 HTML 所在目录，无法决定成片存哪。请重新点一次「选择 HTML 文件」。' }
  try { fs.mkdirSync(outdir, { recursive: true }) } catch (e) {}

  try {
    // 1) 专用场景
    await ensureScene(SCENE_NAME)

    // 2) 自动认窗口 + 建窗口捕获源（缺了它就是黑屏）
    const pw = await autoPickWindow(a.windowTitle)
    if (!pw.ok) return pw
    await ensureWindowCapture(SCENE_NAME, pw.value)

    // 3) 画布对齐到「窗口捕获源的真实像素尺寸」，1:1 不缩放。
    //    以前用的是整块显示器尺寸（比窗口大）→ OBS 把窗口放大铺满画布 → 成片异常模糊。
    let fit = null
    if (a.autoFit !== false) {
      try {
        await wait(700) // 窗口捕获源要一两帧才量得到真实尺寸
        const sz = await getSourceSize(SCENE_NAME, WIN_SOURCE)
        let w = (sz && sz.width) || parseInt(a.width, 10)
        let h = (sz && sz.height) || parseInt(a.height, 10)
        // x264 等编码器要求宽高为偶数，奇数会被 OBS 拒绝或出怪问题
        const even = (n) => Math.max(2, Math.round(n / 2) * 2)
        // 只缩不放：源超过上限就等比降采样（降采样依然锐利，不像放大那样糊），
        // 同时避免 x264 软编在高分辨率下必然掉帧 → 成片抖动。
        // 想录更高分辨率就传 maxWidth（或设环境变量 OBS_MAX_WIDTH）。
        const maxW = parseInt(a.maxWidth || process.env.OBS_MAX_WIDTH || 1920, 10)
        if (w > maxW) { h = Math.round((h * maxW) / w); w = maxW }
        w = even(w)
        h = even(h)
        if (w && h) {
          fit = await fitVideo(w, h)
          // 画布尺寸可能刚变过，重铺一次：左上角对齐 + bounds 等于源尺寸（即 1:1）
          const si = await o.call('GetSceneItemId', { sceneName: SCENE_NAME, sourceName: WIN_SOURCE })
          if (si.sceneItemId != null) {
            await o.call('SetSceneItemTransform', {
              sceneName: SCENE_NAME,
              sceneItemId: si.sceneItemId,
              sceneItemTransform: {
                positionX: 0,
                positionY: 0,
                boundsType: 'OBS_BOUNDS_SCALE_INNER',
                boundsAlignment: 0,
                boundsWidth: w,
                boundsHeight: h,
              },
            })
          }
        }
      } catch (e) { /* 不致命 */ }
    }

    // 4) 音频兜底：必须确认存在「桌面音频」这类能抓系统回放的源。
    //    用 hasAnyAudio() 会被 OBS 自带的麦克风骗过去 → 成片无声。
    let audio = 'exists'
    try {
      if (!(await hasDesktopAudio())) audio = await ensureDesktopAudio(SCENE_NAME)
    } catch (e) {
      audio = 'failed: ' + ((e && e.message) || e)
    }

    // 5) 切场景 + 起录前体检（没视频源 = 黑屏，直接拦下而不是录完才发现）
    await o.call('SetCurrentProgramScene', { sceneName: SCENE_NAME })
    const health = await sceneHealth(SCENE_NAME)
    if (!health.hasVideo) {
      return {
        ok: false,
        error: `场景「${SCENE_NAME}」里仍没有可出画面的源，录出来会是黑屏。场景现有源：${health.summary}`,
      }
    }

    // 6) 输出：目录 + 封装格式（只在当前不是 mp4 时才回写）
    // 不再无条件 SetProfileParameter：那等于每次录制都改一遍用户的 OBS 配置，
    // 既会触发配置变更事件，也会把用户在 OBS 里手动选的格式强行改回来。
    try {
      let needSet = true
      try {
        const cur = await o.call('GetProfileParameter', { parameterCategory: 'AdvOut', parameterName: 'RecFormat2' })
        const v = String((cur && cur.parameterValue) || '').toLowerCase()
        if (v === 'mp4') needSet = false
      } catch (e) { /* 读不到就按"需要设置"处理 */ }
      if (needSet) {
        await o.call('SetProfileParameter', { parameterCategory: 'AdvOut', parameterName: 'RecFormat2', parameterValue: 'mp4' })
      }
    } catch (e) { /* 失败不致命：mkv 也能录 */ }
    try {
      await o.call('SetRecordDirectory', { recordDirectory: outdir })
    } catch (e) {
      return { ok: false, error: '设置 OBS 录制目录失败：' + ((e && e.message) || e) }
    }
    lastOutputDir = outdir
    lastOutputPath = ''

    // 7) 已在录就先停，避免重复 StartRecord 报错
    const st0 = await o.call('GetRecordStatus')
    if (st0.outputActive) {
      await o.call('StopRecord')
      await wait(800)
    }

    await o.call('StartRecord')

    // 确认真正开始（避免"假成功"），并记下 OBS 回传的准确输出路径
    await wait(900)
    const st1 = await o.call('GetRecordStatus')
    if (st1.outputActive === false) {
      return { ok: false, error: 'StartRecord 后录制状态仍为未激活，多半被输出路径/封装格式挡住了。' }
    }
    lastOutputPath = st1.outputPath || ''

    return {
      ok: true,
      scene: SCENE_NAME,
      window: pw.name,
      outdir,
      fit,
      audio,
      health,
      warn: audio.indexOf('failed') === 0 ? '⚠自动补音频源失败，成片可能无声' : '',
    }
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e)
    return { ok: false, error: 'OBS 录制启动失败：' + msg }
  }
}

// 停止录制，回传成片路径。
// 优先用起录时 OBS 回传的 outputPath（精确，且目录里可能本来就有素材视频）；
// 拿不到再退回"按 mtime 取目录内最新视频文件"。
async function stop() {
  // 即便界面认为"没连上"也尝试重连一次：残留的录制必须由 OBS 自己停掉。
  // 否则 OBS 一直停在"输出中"——这正是 设置→输出→录制 页签一点击就被弹回
  // 直播页签 的原因（输出进行中时 OBS 会锁住该页签）。
  if (!connected) {
    const r = await ensureOBSRunning()
    if (!r.ok) return r
  }
  const o = getObs()
  try {
    const st = await o.call('GetRecordStatus')
    if (!st.outputActive) return { ok: true, filePath: '', skipped: true }

    await o.call('StopRecord')

    // 等 OBS 真正收尾：固定 sleep 不够（大文件收尾/remux 更久）。
    // 提前读会拿到残缺文件 → 播放器只能解出第一帧：画面静止、没声音、进度条却在走。
    for (let i = 0; i < 20; i++) {
      await wait(500)
      const s = await o.call('GetRecordStatus')
      if (!s.outputActive) break
    }
    await wait(800)

    // 等文件大小不再增长，确认 OBS 已写完（含 mp4 remux）
    const waitStable = async (fp, maxMs = 10000) => {
      let last = -1
      for (let i = 0; i < maxMs / 500; i++) {
        let s = -1
        try { s = fs.statSync(fp).size } catch (e) { return false }
        if (s > 0 && s === last) return true
        last = s
        await wait(500)
      }
      return false
    }

    const pick = async (fp) => {
      try {
        await waitStable(fp)
        const s = fs.statSync(fp)
        return s.size > 0 ? { ok: true, filePath: fp, dir: path.dirname(fp), size: s.size } : null
      } catch (e) {
        return null
      }
    }

    if (lastOutputPath) {
      const r = await pick(lastOutputPath)
      lastOutputPath = ''
      if (r) return r
    }

    let dir = lastOutputDir
    if (!dir) {
      try { dir = (await o.call('GetRecordDirectory')).recordDirectory } catch (e) {}
    }
    let latest = ''
    let latestMtime = 0
    try {
      for (const f of fs.readdirSync(dir || '.')) {
        if (!/\.(mp4|mkv|mov|flv|ts)$/i.test(f)) continue
        const fp = path.join(dir, f)
        let m
        try { m = fs.statSync(fp).mtimeMs } catch (e) { continue }
        if (m > latestMtime) { latestMtime = m; latest = fp }
      }
    } catch (e) {}
    if (latest) {
      const r = await pick(latest)
      if (r) return r
    }
    return { ok: true, filePath: '', dir: dir || '', skipped: true }
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e)
    return { ok: false, error: 'OBS 停止录制失败：' + msg }
  }
}

// 读取 OBS 真实场景列表（诊断用）
async function listScenes() {
  const o = getObs()
  const r = await connect()
  if (!r.ok) return r
  try {
    const s = await o.call('GetSceneList')
    const scenes = (s.scenes || [])
      .map((x) => ({ name: x.sceneName || x.name, index: typeof x.sceneIndex === 'number' ? x.sceneIndex : 0 }))
      .filter((x) => x.name)
    scenes.sort((a, b) => b.index - a.index) // obs-websocket 返回顺序与界面相反，排回来
    return { ok: true, current: s.currentProgramSceneName || '', scenes: scenes.map((x) => x.name) }
  } catch (e) {
    return { ok: false, error: '读取 OBS 场景列表失败：' + ((e && e.message) || e) }
  }
}

async function status() {
  if (!connected || !obs) return { connected: false }
  try {
    const st = await obs.call('GetRecordStatus')
    return { connected: true, outputActive: st.outputActive, outputPath: st.outputPath || '' }
  } catch (e) {
    return { connected: true, error: (e && e.message) ? e.message : String(e) }
  }
}

async function disconnect() {
  if (obs && connected) {
    try { await obs.disconnect() } catch (e) {}
  }
  connected = false
}

module.exports = {
  SCENE_NAME,
  connect, ensureOBSRunning, resolveObsExe, start, stop, status, listScenes, listWindows, sceneHealth,
  disconnect, isConnected: () => connected,
}
