// HTML-ZtEdit · OBS 录制后端（方案 A：OBS + obs-websocket 系统级录屏）
//
// 把「捕获 + 编码」交给 OBS（系统级 DXGI → 硬件编码 NVENC/QSV/x264），
// Electron 主进程只负责通过 obs-websocket 触发「开始/停止录制」。
// 彻底绕开 v3.3 在 Electron 内 getDisplayMedia + WebCodecs 自编码的清晰度/音频链路坑。
//
// 两种录制对象：
//   mode='browser'（默认，开箱即用）：OBS 建/复用 Browser Source 直接加载本地 HTML 并播放（含 <audio>），
//     自动建场景「HTML-Recorder」+ 源「ztedit-html」，更新其 local_file 指向当前编辑的 HTML。
//   mode='scene'（最高清晰度，需用户在 OBS 一次性预建）：用你已有的「窗口捕获/显示器捕获」场景名，
//     直接 StartRecord/StopRecord，录真实 ztEdit 主窗口（播放时已全屏）→ 清晰度同 Win+Shift+R、上限更高。
//
// 依赖 obs-websocket-js 用 lazy require：本机没装时主进程照常启动，只在连接 OBS 时才报错，
// 不会因缺依赖拖垮整个编辑器。
//
// 集成点（与 src/App.jsx 预留的 window.ztRecSession.startOBS/stopOBS 对应）：
//   connect() / start(opts) / stop() / status() / disconnect()

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const SCENE_NAME = 'HTML-Recorder'
const SOURCE_NAME = 'ztedit-html'
const WINDOW_SOURCE_NAME = 'ztedit-window' // scene 模式自动建的「窗口捕获」源名

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

function fileUrl(p) { return 'file:///' + p.replace(/\\/g, '/') }

function getObs() {
  if (obs) return obs
  // lazy require：缺依赖时只有连接阶段才抛错，不影响编辑器启动
  const pkg = require('obs-websocket-js')
  const OBSWebSocket = pkg.OBSWebSocket || pkg.default || pkg
  obs = new OBSWebSocket()
  return obs
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
    const msg = (e && e.message) ? e.message : String(e)
    return { ok: false, error: '无法连接 OBS：' + msg + '\n请确认：1) OBS 已启动（改过配置需完全退出重开）；2) 工具→obs-websocket 设置 已启用；3) 端口/密码正确（可用 OBS_PORT/OBS_PASSWORD 覆盖）' }
  }
}

// 超采样：让 Browser Source 按 ss 倍（默认 2 → 4K）渲染，CSS 把 body 固定为 1920x1080 逻辑尺寸
// 再用 transform:scale(ss) 精确放大填满大视口——文字边缘被高分辨率采样→锐利，且不被裁切。
// 注意：不能用 zoom（body{width:100%} 会先铺满大视口再放大导致溢出裁切）。
function supersampleCss(zoom) {
  return 'body{width:1920px;height:1080px;margin:0;transform:scale(' + zoom + ');transform-origin:0 0;overflow:hidden}'
}

async function ensureSceneAndSource(opts) {
  const o = getObs()
  const width = opts.width || 1920
  const height = opts.height || 1080
  const zoom = opts.zoom || (width / 1920)
  const htmlPath = opts.htmlPath || ''

  try { await o.call('CreateScene', { sceneName: SCENE_NAME }) } catch (e) { /* 已存在则复用 */ }

  let exists = false
  try {
    const si = await o.call('GetSceneItemId', { sceneName: SCENE_NAME, sourceName: SOURCE_NAME })
    exists = !!si.sceneItemId
  } catch (e) { exists = false }

  const settings = {
    is_local_file: true,
    local_file: htmlPath,
    url: fileUrl(htmlPath),
    width: width,
    height: height,
    fps: opts.fps || 60,
    fps_custom: false,
    css: supersampleCss(zoom),
    shutdown_when_inactive: false,
    restart_when_active: true,
  }

  if (!exists) {
    await o.call('CreateInput', {
      sceneName: SCENE_NAME, inputName: SOURCE_NAME,
      inputKind: 'browser_source', inputSettings: settings, setVisible: true,
    })
  } else {
    await o.call('SetInputSettings', {
      inputName: SOURCE_NAME,
      inputSettings: {
        is_local_file: true, local_file: htmlPath, url: fileUrl(htmlPath),
        width: width, height: height, fps: opts.fps || 60,
        css: supersampleCss(zoom),
      },
    })
  }
  await o.call('SetCurrentProgramScene', { sceneName: SCENE_NAME })
}

// 列出 OBS 能捕获的窗口（供 UI 下拉选择，杜绝手打窗口标识字符串出错）
async function listWindows() {
  const o = getObs()
  const r = await connect()
  if (!r.ok) return r
  try {
    const p = await o.call('GetInputPropertiesListPropertyItems', {
      inputKind: 'window_capture',
      propertyName: 'window',
    })
    const items = (p.propertyItems || [])
      .map((x) => ({ name: x.itemName || '', value: x.itemValue || '' }))
      .filter((x) => x.value)
    return { ok: true, windows: items }
  } catch (e) {
    return { ok: false, error: '读取可捕获窗口列表失败：' + ((e && e.message) || e) }
  }
}

// 建/更新「窗口捕获」源指向 ztEdit 主窗口，并把源缩放铺满画布。
// 这就是「把画面送进 OBS 场景」的环节——缺了它，场景里没有视频源，录出来就是黑屏（用户实测踩坑）。
// 用 bounds(OBS_BOUNDS_SCALE_INNER) 铺满：不需要知道源原始尺寸，也不会出现"只录到左上角一部分"。
async function ensureWindowCapture(sceneName, windowVal) {
  const o = getObs()
  const inputName = WINDOW_SOURCE_NAME
  let exists = false
  try {
    const si = await o.call('GetSceneItemId', { sceneName, sourceName: inputName })
    exists = si.sceneItemId != null
  } catch (e) {
    exists = false
  }

  const settings = { window: windowVal, capture_cursor: false }
  if (!exists) {
    await o.call('CreateInput', {
      sceneName,
      inputName,
      inputKind: 'window_capture',
      inputSettings: settings,
      setVisible: true,
    })
  } else {
    await o.call('SetInputSettings', { inputName, inputSettings: settings })
  }

  try {
    const v = await o.call('GetVideoSettings')
    const si = await o.call('GetSceneItemId', { sceneName, sourceName: inputName })
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

// 场景体检：列出场景里有哪些源、各自类型，判断有没有视频源/音频源。
// 黑屏 = 没有视频源；无声 = 没有音频源。起录前先体检，把根因直接摆出来而不是让人猜。
async function sceneHealth(sceneName) {
  const o = getObs()
  const list = ((await o.call('GetSceneItemList', { sceneName })).sceneItems) || []
  const kinds = {}
  try {
    const ins = await o.call('GetInputList')
    for (const it of ins.inputs || []) kinds[it.inputName] = it.inputKind
  } catch (e) {
    /* 拿不到类型表就退化成 unknown，仅影响提示准确度 */
  }
  const items = list.map((it) => {
    const n = it.sourceName || ''
    return {
      name: n,
      kind: kinds[n] || it.sourceKind || 'unknown',
      enabled: it.sceneItemEnabled !== false,
    }
  })
  const hasVideo = items.some((f) => f.enabled && VIDEO_KINDS.indexOf(f.kind) >= 0)
  const hasAudio = items.some((f) => f.enabled && AUDIO_KINDS.indexOf(f.kind) >= 0)
  const summary = items.length ? items.map((f) => `${f.name}(${f.kind})`).join('、') : '（空，一个源都没有）'
  return { hasVideo, hasAudio, items, summary }
}

// 开始录制。opts:
//   { mode:'browser'|'scene', sceneName, window, htmlPath, ss, width, height, fps, outdir }
async function start(opts) {
  const o = getObs()
  const a = opts || {}
  const mode = a.mode || 'browser'
  const ss = parseFloat(a.ss) || 2

  const r = await connect()
  if (!r.ok) return r

  let health = null
  try {
    if (mode === 'scene') {
      // 关键：绝不猜场景名。先向 OBS 要真实场景列表，校验通过再切。
      // 没指定场景名时用「OBS 当前场景」（必然存在），而不是硬编码的 HTML-Recorder
      // （那是独立脚本建的，常不在用户当前场景集合里 → "No source was found by the name of ..."）。
      const s = await o.call('GetSceneList')
      const names = (s.scenes || []).map((x) => x.sceneName || x.name).filter(Boolean)
      const current = s.currentProgramSceneName || ''
      const sceneName = a.sceneName || current
      if (!sceneName) {
        return { ok: false, error: 'OBS 当前场景集合里没有任何场景，请先在 OBS 建一个场景（含窗口捕获源）。' }
      }
      if (names.length && names.indexOf(sceneName) < 0) {
        return {
          ok: false,
          error:
            `OBS 里找不到名为「${sceneName}」的场景。` +
            `当前场景集合可用场景：${names.join('、') || '（空）'}。` +
            `请从下拉列表里选一个，或把 OBS 切到含该场景的场景集合。`,
        }
      }
      // 自动建/更新「窗口捕获」源指向 ztEdit 主窗口 —— 这就是"把画面送进 OBS 场景"的环节。
      // 不做这一步，场景里没有视频源，StartRecord 照常成功但录出来全是黑屏（用户实测踩坑）。
      if (a.window) {
        try {
          await ensureWindowCapture(sceneName, a.window)
        } catch (e) {
          return { ok: false, error: '在场景里建「窗口捕获」源失败：' + ((e && e.message) || e) }
        }
      }
      await o.call('SetCurrentProgramScene', { sceneName: sceneName })

      // 起录前体检：没视频源 = 黑屏，没音频源 = 无声。把根因直接摆出来，而不是让人猜
      health = await sceneHealth(sceneName)
      if (!health.hasVideo) {
        return {
          ok: false,
          error:
            `场景「${sceneName}」里没有可出画面的源，录出来会是黑屏。` +
            (a.window ? '' : '请在「窗口」下拉里选 ztEdit 主窗口（会自动建窗口捕获源），') +
            `或在 OBS 里手动给该场景加一个窗口/显示器捕获源。场景现有源：${health.summary}`,
        }
      }
    } else {
      // 计算超采样渲染尺寸
      const width = a.width ? parseInt(a.width, 10) : Math.round(1920 * ss)
      const height = a.height ? parseInt(a.height, 10) : Math.round(1080 * ss)
      await ensureSceneAndSource({ width, height, fps: a.fps || 60, htmlPath: a.htmlPath || '', zoom: width / 1920 })
    }

    // 锁画布/输出分辨率（browser 模式用超采样尺寸，scene 模式不动）
    if (mode === 'browser') {
      const width = a.width ? parseInt(a.width, 10) : Math.round(1920 * ss)
      const height = a.height ? parseInt(a.height, 10) : Math.round(1080 * ss)
      try {
        await o.call('SetVideoSettings', {
          baseWidth: width, baseHeight: height,
          outputWidth: width, outputHeight: height,
          fpsNumerator: a.fps || 60, fpsDenominator: 1,
        })
      } catch (e) { /* 失败不致命 */ }
    }

    // 录制格式 mp4（Simple 用 RecFormat，Advanced 用 RecFormat2；失败不致命，mkv 亦可）
    try {
      await o.call('SetProfileParameter', { parameterCategory: 'Output', parameterName: 'RecFormat', parameterValue: 'mp4' })
      await o.call('SetProfileParameter', { parameterCategory: 'AdvOut', parameterName: 'RecFormat2', parameterValue: 'mp4' })
    } catch (e) { /* 失败不致命 */ }

    // 输出目录：确保存在 + 纯 ASCII 更稳（含全角逗号等路径 FFmpeg 易初始化失败）
    const outdir = a.outdir || 'D:/obs-recordings'
    try { fs.mkdirSync(outdir, { recursive: true }) } catch (e) {}
    try {
      await o.call('SetRecordDirectory', { recordDirectory: outdir })
    } catch (e) { /* 失败不致命 */ }

    // 若已在录，先停（避免重复 StartRecord 报错）
    const st0 = await o.call('GetRecordStatus')
    if (st0.outputActive) {
      await o.call('StopRecord')
      await new Promise((res) => setTimeout(res, 800))
    }

    await o.call('StartRecord')

    // 确认真正开始（避免「假成功」）
    await new Promise((res) => setTimeout(res, 1000))
    const st1 = await o.call('GetRecordStatus')
    if (st1.outputActive === false) {
      return { ok: false, error: 'StartRecord 后录制状态仍为未激活，可能被输出路径/格式阻止' }
    }
    return { ok: true, mode, outdir, health }
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e)
    return { ok: false, error: 'OBS 录制启动失败：' + msg }
  }
}

// 停止录制，返回最近生成的文件路径（OBS 不回传刚录文件名，这里按 mtime 取目录内最新 mp4/mkv）
async function stop() {
  const o = getObs()
  if (!connected) return { ok: false, error: '尚未连接 OBS' }
  try {
    const wasActive = await o.call('GetRecordStatus')
    if (!wasActive.outputActive) return { ok: true, filePath: '', skipped: true }

    await o.call('StopRecord')
    // 等 OBS 写盘收尾
    await new Promise((res) => setTimeout(res, 1200))

    const rd = await o.call('GetRecordDirectory')
    const dir = rd.recordDirectory
    let latest = ''
    let latestMtime = 0
    try {
      const files = fs.readdirSync(dir)
      for (const f of files) {
        if (!/\.(mp4|mkv|mov|flv)$/i.test(f)) continue
        const fp = path.join(dir, f)
        let m
        try { m = fs.statSync(fp).mtimeMs } catch (e) { continue }
        if (m > latestMtime) { latestMtime = m; latest = fp }
      }
    } catch (e) {}
    return { ok: true, filePath: latest, dir }
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e)
    return { ok: false, error: 'OBS 停止录制失败：' + msg }
  }
}

// 读取 OBS 真实场景列表：给 UI 做下拉选择，杜绝手打场景名打错 / 场景不在当前场景集合
async function listScenes() {
  const o = getObs()
  const r = await connect()
  if (!r.ok) return r
  try {
    const s = await o.call('GetSceneList')
    const scenes = (s.scenes || [])
      .map((x) => ({
        name: x.sceneName || x.name,
        index: typeof x.sceneIndex === 'number' ? x.sceneIndex : 0,
      }))
      .filter((x) => x.name)
    // obs-websocket 返回的数组顺序与 OBS 界面相反（index 大的在界面顶部），排回来更直观
    scenes.sort((a, b) => b.index - a.index)
    return {
      ok: true,
      current: s.currentProgramSceneName || '',
      scenes: scenes.map((x) => x.name),
    }
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
  connect, start, stop, status, listScenes, listWindows, sceneHealth,
  disconnect, isConnected: () => connected,
}
