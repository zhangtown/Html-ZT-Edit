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
const BROWSER_SOURCE = 'zt-html'             // OBS 原生浏览器源（HTML 直接交给 OBS 内置 CEF 渲染）

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

// OBS 配置根目录（profile 的 basic.ini 在这里）。websocket config 用的是同一个根。
function obsConfigRoot() {
  return path.join(os.homedir(), 'AppData/Roaming/obs-studio')
}

// 色阶范围：浏览器源是 Full(0-255)，OBS 默认 Partial(16-235) 会把高光压灰、暗部抬灰 → 画面发暗发灰。
// 这是录出来的视频「比双击打开暗」的根本原因。
// 关键：OBS 只在「启动时」把 ColorRange 读进内存的 obs_video_info，运行时改 profile 不生效（无 ResetVideo 可用），
// 所以必须在 OBS 启动之前把 INI 写好，OBS 一启动即读到 Full。这里遍历所有 profile 的 basic.ini 改写。
function ensureColorRangeFullInIni() {
  try {
    const root = obsConfigRoot()
    const profiles = path.join(root, 'basic', 'profiles')
    if (!fs.existsSync(profiles)) return { ok: true, note: 'no profiles dir' }
    let changed = 0
    for (const dir of fs.readdirSync(profiles)) {
      const ini = path.join(profiles, dir, 'basic.ini')
      if (!fs.existsSync(ini)) continue
      let t = fs.readFileSync(ini, 'utf8')
      // 只改 [Video] 段里的 ColorRange=Partial → Full（用行级匹配，避免误伤注释/其它段）
      let modified = false
      const lines = t.split(/\r?\n/)
      let inVideo = false
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (/^\s*\[/.test(line)) inVideo = /^\s*\[Video\]/.test(line)
        if (inVideo && /^\s*ColorRange\s*=/.test(line)) {
          const v = line.split('=')[1].trim()
          if (v.toLowerCase() !== 'full') { lines[i] = line.replace(/=.*/, '=Full'); modified = true }
        }
      }
      if (modified) { fs.writeFileSync(ini, lines.join('\n'), 'utf8'); changed++ }
    }
    return changed ? { ok: true, note: 'wrote ColorRange=Full to ' + changed + ' profile(s)' } : { ok: true, note: 'already Full' }
  } catch (e) {
    return { ok: false, error: '改 OBS 色阶 INI 失败：' + ((e && e.message) || e) }
  }
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
    // OBS 未运行才改 INI：此时 OBS 尚没读配置，改完它启动即读到 Full（运行时改无效）。
    // 若 OBS 已在跑，INI 改了对本次无效，但至少下次启动生效；此处不强制重启，保证录屏流程不被打断。
    try { const r = ensureColorRangeFullInIni(); if (r && r.note) console.log('[obsRecorder] 色阶：', r.note) } catch (e) {}
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

// 清理录制环境：每次起录前把我们的专用场景「ZT-录制」整个删掉重建，
// 清掉上一次（尤其是被强杀/中断）残留的场景与源，避免多次录制把源叠在一起 → 成片双画面/双音。
// OBS 不允许直接删「当前场景」或「唯一场景」，所以先切到一个备胎场景再删。
async function cleanEnvironment() {
  const o = getObs()
  const s = await o.call('GetSceneList')
  const names = (s.scenes || []).map((x) => x.sceneName || x.name).filter(Boolean)
  if (names.indexOf(SCENE_NAME) < 0) return // 本就没有，无需清理
  // 备胎场景：没有就建一个，保证能切走再删 ZT-录制
  let other = names.find((n) => n !== SCENE_NAME)
  if (!other) {
    const fb = 'ZT-备用'
    try { await o.call('CreateScene', { sceneName: fb }) } catch (e) {}
    other = fb
  }
  try { await o.call('SetCurrentProgramScene', { sceneName: other }) } catch (e) {}
  await wait(200)
  try { await o.call('RemoveScene', { sceneName: SCENE_NAME }) } catch (e) {}
  await wait(200)
}

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
// OBS 原生浏览器源（HTML 直接交给 OBS 内置 CEF 渲染）
// ---------------------------------------------------------------------------

// 建/更新「OBS 原生浏览器源」：HTML 直接交给 OBS 内置 CEF 渲染，无需临时窗口/文件管理。
// 浏览器源自带音轨（VIDEO_KINDS/AUDIO_KINDS 都已含 browser_source），所以不补桌面音频。
// 分辨率由我们显式设（width/height），OBS 画布对齐到它即可 1:1 最锐利。
//
// 注意输入「全局存在、按场景引用」：cleanEnvironment 删场景后，输入 zt-html 仍全局存在，
// 此时 GetSceneItemId 会找不到（已不在场景里）→ 用 CreateSceneItem 把它加回新场景，
// 不能再用 CreateInput（同名输入已存在会报错）。只有输入从未建过才走 CreateInput。
async function ensureBrowserSource(sceneName, url, width, height) {
  const o = getObs()
  const w = width || 1920
  const h = height || 1080
  const settings = {
    url: url,
    width: w,
    height: h,
    fps: 30,
    css: '',
    // 关键：把音频交给 OBS 内部接管，不再走系统声卡（control_audio_via_os=true）。
    // 否则 HTML 的 MP3 既被浏览器源录一轨、又从扬声器出去被 OBS 全局桌面音频再抓一轨，
    // 两路同一声音略有延迟 → 成片「两个音频前后一起播放/回声」。设 true 后只剩浏览器源这一轨。
    control_audio_via_os: true,
    // OBS 浏览器源基于 CEF，默认放开自动播放（含带声）。若个别 OBS 版本拦自动播放，
    // 可在 OBS 设置→高级 里把「浏览器源」相关自动播放策略放宽；本工具不强行改用户配置。
  }
  // 输入是否全局存在（与是否在场景里无关）
  let inputExists = false
  try {
    const ins = await o.call('GetInputList')
    inputExists = (ins.inputs || []).some((it) => it.inputName === BROWSER_SOURCE)
  } catch (e) { inputExists = false }

  if (!inputExists) {
    await o.call('CreateInput', {
      sceneName,
      inputName: BROWSER_SOURCE,
      inputKind: 'browser_source',
      inputSettings: settings,
      setVisible: true,
    })
    return true
  }

  // 输入已存在：确保它在本场景里（删场景后可能已不在）
  let inScene = false
  try {
    const si = await o.call('GetSceneItemId', { sceneName, sourceName: BROWSER_SOURCE })
    inScene = si && si.sceneItemId != null
  } catch (e) { inScene = false }
  if (!inScene) {
    try {
      await o.call('CreateSceneItem', { sceneName, sourceName: BROWSER_SOURCE, setVisible: true })
    } catch (e) { /* 已存在则忽略 */ }
  }
  // 仅在设置真正变化时才回写 SetInputSettings——该调用会让 OBS 重载浏览器源，
  // 重载会重新触发页面 load → 引擎 startPlayback 再播一次（配合「场景激活时刷新」就可能播两遍）。
  // url 没变就跳过，避免一次录制里出现两次播放。
  let changed = false
  try {
    const cur = await o.call('GetInputSettings', { inputName: BROWSER_SOURCE })
    const cs = (cur && cur.inputSettings) || {}
    if (cs.url !== settings.url || cs.width !== settings.width || cs.height !== settings.height || cs.control_audio_via_os !== true) changed = true
  } catch (e) { changed = true }
  if (changed) await o.call('SetInputSettings', { inputName: BROWSER_SOURCE, inputSettings: settings })
  // 强制 1:1 铺满画布：复用的旧源可能带着上次（或用户在 OBS 里手工拖动/缩放）留下的 transform。
  // 只要 scale≠1 或没对齐左上角，画面就会被缩放或裁切 —— 表现为"发糊""内容少一截"。
  // 源尺寸已等于画布，这里把变换复位即可保证像素级 1:1。
  try {
    const si = await o.call('GetSceneItemId', { sceneName, sourceName: BROWSER_SOURCE })
    if (si && si.sceneItemId != null) {
      await o.call('SetSceneItemTransform', {
        sceneName,
        sceneItemId: si.sceneItemId,
        sceneItemTransform: {
          positionX: 0, positionY: 0, scaleX: 1, scaleY: 1,
          boundsType: 'OBS_BOUNDS_NONE', alignment: 5,
        },
      })
    }
  } catch (e) { /* 读不到/设不动就算了，源本身已是 1:1 */ }
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
// 录制画质兜底
// ---------------------------------------------------------------------------

// 成片糊不糊，除分辨率外主要由「码率 / CRF」决定：1080p 下 CBR 低于 ~10Mbps、
// CRF 大于 ~20 就会肉眼可见地发糊（尤其 HTML 里的细文字与描边）。
// 这套配置是用户在 OBS 里长期用的，工具不该全盘覆盖，所以这里只做**只升不降**的兜底：
// 仅当当前设置明显低于高清档时才抬上去；用户已经是高清/无损则一个字节都不动。
// 改的是 OBS 配置，在 StartRecord 之前调用即可生效（录制进行中改会失败）。
const HD_BITRATE_KBPS = 20000   // 1080p 高清档（清晰度优先，固定码率上限）
const HD_CRF = 12               // CRF/CQP 数值越小越清晰（极致档）

async function ensureRecordQuality() {
  const o = getObs()
  const notes = []
  const readP = async (cat, name) => {
    try {
      const r = await o.call('GetProfileParameter', { parameterCategory: cat, parameterName: name })
      const v = r && r.parameterValue
      return (v === undefined || v === null || v === '') ? undefined : v
    } catch (e) { return undefined }
  }
  const setP = async (cat, name, val) => {
    try {
      await o.call('SetProfileParameter', { parameterCategory: cat, parameterName: name, parameterValue: val })
      return true
    } catch (e) { return false }
  }

  // 色阶：OBS 运行时改 profile 不生效（启动时才读入内存 obs_video_info，无 ResetVideo），
  // 已由 ensureOBSRunning() 在 OBS 启动前写 INI 保证 Full。这里无需再走运行时 setP。

  // 简单输出：录制画质保存在 SimpleOutput，通常是「与推流相同(Stream)」→ 看推流码率
  for (const [cat, name, min, target, label] of [
    ['SimpleOutput', 'VBitrate', 12000, HD_BITRATE_KBPS, '推流/录制码率'],
    ['AdvOut', 'Recbitrate', 12000, HD_BITRATE_KBPS, '录制码率'],
  ]) {
    const v = parseInt(await readP(cat, name), 10)
    if (Number.isFinite(v) && v > 0 && v < min) {
      if (await setP(cat, name, target)) notes.push(`${label} ${v}→${target}kbps`)
    }
  }
  // CRF / CQP：数值越大越糊
  for (const [cat, name] of [['AdvOut', 'RecCRF'], ['AdvOut', 'RecCQP']]) {
    const v = parseInt(await readP(cat, name), 10)
    if (Number.isFinite(v) && v > HD_CRF) {
      if (await setP(cat, name, HD_CRF)) notes.push(`${name} ${v}→${HD_CRF}`)
    }
  }
  // 简单输出的录制质量档：Small（省空间，最糊）抬到 HQ，其余（Stream/HQ/Lossless）不动
  const q = String(await readP('SimpleOutput', 'RecQuality') || '').toLowerCase()
  if (q === 'small') {
    if (await setP('SimpleOutput', 'RecQuality', 'HQ')) notes.push('录制质量档 Small→HQ')
  }
  return notes
}

// ---------------------------------------------------------------------------
// 起停
// ---------------------------------------------------------------------------

// 开始录制。opts:
//   { outdir, browserUrl, width, height, maxWidth, autoFit }
//   outdir 必填——成片直接落在当前编辑的 HTML 所在目录。
//   仅 OBS 原生浏览器源模式：browserUrl 为落盘的 录屏源.html 的 file:// 地址。
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
      // 0) 清理环境：每次起录前删掉残留的「ZT-录制」场景（含旧源），保证干净起点，
      //    避免多次录制把源叠在一起（成片双画面/双音）。之后再重建。
      await cleanEnvironment()
      // 1) 专用场景
      await ensureScene(SCENE_NAME)

      // 2) + 3) + 4) 画面源与音频（仅 OBS 原生浏览器源模式）
      const maxW = parseInt(a.maxWidth || process.env.OBS_MAX_WIDTH || 1920, 10)
      const even = (n) => Math.max(2, Math.round(n / 2) * 2)
      let fit = null
      let audio = 'exists'
      let qualityNotes = []
      // ── OBS 原生浏览器源模式 ──
      // HTML 直接交给 OBS 内置 CEF 渲染：无临时窗口、无临时文件生命周期、分辨率=我们设的画布。
      // 浏览器源自带音轨，不补桌面音频（避免声音翻倍）。
      if (!a.browserUrl) return { ok: false, error: '浏览器源模式缺少 HTML 地址（browserUrl）。' }
      const bw = parseInt(a.width, 10) || 1920
      const bh = parseInt(a.height, 10) || 1080
      // 先定画布、再建源：源尺寸必须等于画布才能 1:1 最锐利。
      // 顺序反了的话，一旦画布被 maxW 缩小，源会比画布大 → 画面被裁掉一圈
      //（表现为"内容少一截/边缘被切"），而且缩放下采样会让细文字发糊。
      let w = even(bw), h = even(bh)
      if (w > maxW) { h = even(Math.round((h * maxW) / w)); w = even(maxW) }
      if (w && h) fit = await fitVideo(w, h)
      await ensureBrowserSource(SCENE_NAME, a.browserUrl, w, h)
      // 录制画质兜底（只升不降）：1080p 下码率过低/CRF 过高会明显发糊
      const qnotes = await ensureRecordQuality()
      if (qnotes.length) qualityNotes = qnotes
      audio = 'browser-source'
      a.windowTitle = '' // 浏览器源模式不需要匹配窗口标题

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
      window: 'OBS 浏览器源',
      captureMode: a.captureMode,
      outdir,
      fit,
      audio,
      health,
      quality: qualityNotes,
      warn: (audio && audio.indexOf && audio.indexOf('failed') === 0) ? '⚠自动补音频源失败，成片可能无声' : '',
    }
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e)
    return { ok: false, error: 'OBS 录制启动失败：' + msg }
  }
}

// 停止录制，回传成片路径。
// 优先用起录时 OBS 回传的 outputPath（精确，且目录里可能本来就有素材视频）；
// 停止录制后关闭 OBS 进程：浏览器源是 OBS 内置 CEF 持续渲染，
// 只停录制不关 OBS，HTML 会在场景里继续播放（动画/音频仍在跑）。
// 用户要求「结束录制即关 OBS」——但必须**优雅退出**，不能强杀：
// taskkill /F 会让 OBS 下次启动弹「安全模式」选择框。这里先断 websocket，
// 再发不带 /F 的 taskkill（WM_CLOSE，OBS 正常保存配置退出）；仅当几秒后进程仍在
// （如有模态框卡住）才升级到 /F 作为最后手段。非 Windows 直接 disconnect。
async function killOBS() {
  if (process.platform !== 'win32') {
    try { if (obs) obs.disconnect() } catch (e) {}
    return { ok: true, killed: false, note: '非 Windows，未杀进程' }
  }
  try {
    // 先断开 websocket，让 OBS 侧连接自然结束
    try { if (obs) obs.disconnect() } catch (e) {}
    connected = false
    // 优雅关闭：不带 /F，发 WM_CLOSE，OBS 会正常退出（不弹安全模式）
    spawnSync('taskkill', ['/IM', 'obs64.exe'], { windowsHide: true })
    // 等 OBS 自己收尾（保存配置 + 退出通常很快）
    let gone = false
    for (let i = 0; i < 10; i++) {
      await wait(500)
      if (!isObsRunning()) { gone = true; break }
    }
    // 兜底：仍有残留（卡住）才强杀
    if (!gone) {
      try { spawnSync('taskkill', ['/IM', 'obs64.exe', '/F'], { windowsHide: true }) } catch (e) {}
      for (let i = 0; i < 6; i++) {
        await wait(500)
        if (!isObsRunning()) { gone = true; break }
      }
    }
    return { ok: true, killed: gone, note: gone ? '已优雅关闭 OBS' : '关闭超时（已强杀兜底）' }
  } catch (e) {
    return { ok: false, error: String(e && e.message) }
  }
}

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
  connect, ensureOBSRunning, resolveObsExe, start, stop, killOBS, status, sceneHealth,
  disconnect, isConnected: () => connected,
}
