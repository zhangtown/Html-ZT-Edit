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

// 各家显卡录制编码器 ID（按新旧/可用性排序）：OBS 版本与驱动不同，实际注册的 ID 不一样——
// 例如 AMD 在 OBS 28+ 只注册新版 h264_texture_amf（老的 obs_amf_h264 随旧插件移除，写它起录必失败）；
// NVIDIA 的 obs_nvenc_h264_tex 也是新实现，老版本只有 obs_nvenc_h264。
// 具体以「当前 OBS 实例启动日志里的 Available Encoders 清单」为准，见 ensureRecEncoderWorks() 的自检修复。
const ENCODER_IDS_BY_VENDOR = {
  nvidia: ['obs_nvenc_h264_tex', 'obs_nvenc_h264', 'obs_nvenc_h264_soft'],
  amd: ['h264_texture_amf', 'obs_amf_h264'],
  intel: ['obs_qsv_h264'],
  cpu: ['obs_x264'],
}

// 编码器 ID → 界面友好名（自检修复换编码器后回传/展示用）
const ENCODER_LABELS = {
  obs_nvenc_h264_tex: 'NVIDIA NVENC', obs_nvenc_h264: 'NVIDIA NVENC', obs_nvenc_h264_soft: 'NVIDIA NVENC',
  h264_texture_amf: 'AMD AMF', obs_amf_h264: 'AMD AMF',
  obs_qsv_h264: 'Intel QSV',
  obs_x264: 'x264 (CPU)',
}
const encoderLabel = (id) => ENCODER_LABELS[id] || (id ? '编码器 ' + id : '')

// 编码器选择的跨会话记忆（同 OBS_EXE 的 setx 固化思路）：只记「编码器自检确认可用」的结果。
// 若不记忆，ztEdit 重启后冷启动会重新探测，探测结果一旦与本机 OBS 实际清单有出入，
// 就会触发「杀掉刚拉起的 OBS → 重启修复」循环（用户看到 OBS 关闭再重启）。
function persistedEncoder() {
  const id = process.env.OBS_REC_ENCODER
  if (!id) return null
  const vendor =
    Object.keys(ENCODER_IDS_BY_VENDOR).find((v) => (ENCODER_IDS_BY_VENDOR[v] || []).indexOf(id) >= 0) || 'cpu'
  return { id, vendor, name: encoderLabel(id) }
}
function persistObsEncoder(id) {
  process.env.OBS_REC_ENCODER = id // 当前进程立即可读；setx 供下次启动的 ztEdit 读到
  try { spawnSync('setx', ['OBS_REC_ENCODER', id], { windowsHide: true }) } catch (e) {}
}

let obs = null            // OBSWebSocket 实例（单例）
let connected = false
let lastOutputPath = ''   // 起录时 OBS 回传的准确输出路径（stop 时优先用它，比扫目录可靠）
let lastOutputDir = ''    // 起录时的输出目录（stop 时扫目录兜底用）
let lastEncoder = ''       // 本次选定的录制硬件编码器（按显卡自动：NVIDIA NVENC / AMD AMF / Intel QSV / x264）
let lastEncoderId = ''     // 本次写入 OBS 配置的编码器 ID（自检修复时对照当前实例真实清单用）
let lastVendor = ''        // 本次编码器所属显卡厂商（自检修复优先挑同厂商的可用 ID）

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

// 色阶范围（ColorRange）：录屏链路强制 Full(0-255)——浏览器源本身就是 Full，Full 直通保真度最高（多 37 级灰阶）。
// 历史：ae02cc3 曾强制 Partial/tv（当时 PotPlayer DXVA 硬解不尊重 color_range=pc，会把 Full 素材按 tv 解码 → 过曝发白）。
// 2026-09 定案 Full：PotPlayer 关闭 DXVA（软件解码尊重 VUI）后 Full 正常；剪映实测 Full 直通也正常。
// 注意：ColorRange 只能在 OBS 启动前改 INI 才生效（运行时改无效，无 ResetVideo），故在 OBS 未运行时遍历所有 profile 改写。
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
      // 只改 [Video] 段里的 ColorRange=Partial → Full（行级匹配，避免误伤注释/其它段）
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

// 录制编码器质量兜底：OBS 把「录制编码器」的真实参数（rate_control/crf/cqp/bitrate）存在
// profile 目录的 recordEncoder.json（注意：basic.ini 的 [AdvOut] 只有 RecEncoder=obs_x264 这种「用哪个编码器」，
// 真正的质控参数不在那里）。之前 ensureRecordQuality 用 SetProfileParameter 改 basic.ini 的
// Recbitrate/RecCRF/RecCQP —— 那些键在 OBS 里根本不存在（真参在 recordEncoder.json），所以一直没生效。
// 这里改为直接读写 recordEncoder.json，只升不降：CRF/CQP 过大（会糊）抬回高清档；CBR/VBR 码率过低抬到高清档。
// 关键：参数形状随编码器走 —— x264/NVENC/QSV 用 rate_control=CRF + crf，AMD 硬件编码器（h264_texture_amf）
// 只认 rate_control=CQP/CBR/VBR + cqp（不认 CRF/crf）。切换编码器时要把形状一起换掉，
// 否则质控参数被 AMF 忽略 → 退回 CBR 默认码率，4K 录制会糊且文件巨大。
// 和 ColorRange 一样必须在 OBS 启动前写好（OBS 启动时才把编码器设置读进内存），运行时改无效。
// opts.encoderId 传入本次选定的编码器 ID（AMD → 按 AMF 形状写，其余 → 按 x264 形状写）。
function ensureRecordEncoderJson(opts) {
  const o = opts || {}
  const tgt = targetBitrate(o.width, o.height)
  const isAmf = o.encoderId === 'h264_texture_amf' || o.encoderId === 'obs_amf_h264'
  try {
    const root = obsConfigRoot()
    const profiles = path.join(root, 'basic', 'profiles')
    if (!fs.existsSync(profiles)) return { ok: true, note: 'no profiles dir' }
    const changed = []
    for (const dir of fs.readdirSync(profiles)) {
      const p = path.join(profiles, dir, 'recordEncoder.json')
      if (!fs.existsSync(p)) continue
      let cfg
      try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { continue }
      if (!cfg || typeof cfg !== 'object') continue
      const rc = String(cfg.rate_control || '').toUpperCase()
      let note = ''
      if (isAmf) {
        // AMF 形状：rate_control=CQP/CBR/VBR + cqp。把 x264 遗留的 CRF/crf 等量平移成 CQP/cqp。
        const q = [Number(cfg.cqp), Number(cfg.crf)].find((v) => Number.isFinite(v))
        if (rc === 'CQP') {
          if (Number.isFinite(q) && q > HD_CRF) { cfg.cqp = HD_CRF; note = 'CQP ' + q + '→' + HD_CRF }
        } else if (rc === 'CBR' || rc === 'VBR') {
          const v = Number(cfg.bitrate)
          if (!Number.isFinite(v) || v < tgt) {
            note = (Number.isFinite(v) ? 'bitrate ' + v + '→' : 'bitrate 缺省→') + tgt + 'kbps'
            cfg.bitrate = tgt
          }
        } else if (rc) {
          // CRF 等其它取值（x264 时代留下的）→ 整体转成 AMF 的 CQP，数值等量平移、只升不降
          cfg.rate_control = 'CQP'
          cfg.cqp = Number.isFinite(q) && q <= HD_CRF ? q : HD_CRF
          note = 'AMF 参数形状：' + (rc === 'CRF' ? 'CRF' : rc) + '→CQP(cqp=' + cfg.cqp + ')'
        }
      } else if (rc === 'CRF') {
        const v = Number(cfg.crf)
        if (Number.isFinite(v) && v > HD_CRF) { cfg.crf = HD_CRF; note = 'CRF ' + v + '→' + HD_CRF }
      } else if (rc === 'CQP') {
        const v = Number(cfg.cqp)
        if (Number.isFinite(v) && v > HD_CRF) { cfg.cqp = HD_CRF; note = 'CQP ' + v + '→' + HD_CRF }
      } else if (rc === 'CBR' || rc === 'VBR') {
        const v = Number(cfg.bitrate)
        // 缺省(undefined)或低于目标 → 抬到目标码率（之前缺省时 OBS 用默认 10M，太糊）
        if (!Number.isFinite(v) || v < tgt) {
          note = (Number.isFinite(v) ? 'bitrate ' + v + '→' : 'bitrate 缺省→') + tgt + 'kbps'
          cfg.bitrate = tgt
        }
      }
      if (note) {
        fs.writeFileSync(p, JSON.stringify(cfg), 'utf8')
        changed.push(note)
      }
    }
    return changed.length
      ? { ok: true, changed: true, note: changed.join('；') }
      : { ok: true, changed: false, note: '' }
  } catch (e) {
    return { ok: false, error: '改 OBS 录制编码器 JSON 失败：' + ((e && e.message) || e) }
  }
}

// obs-websocket 的 WebSocket 服务默认是关闭的（server_enabled:false），不先启用则应用连不上
//（表现为 "OBS 能开但连不上/不加载 HTML/不开始录制"）。与 ColorRange/编码器一样，必须在 OBS 启动前写好
//（OBS 启动时才把插件配置读进内存）。配置已存在：仅把 server_enabled 置 true，保留用户端口/密码；
// 配置不存在：生成默认开启的配置（写入一份密码供应用连接时读取）。
function ensureObsWebsocketEnabled() {
  try {
    const cfg = path.join(os.homedir(), 'AppData/Roaming/obs-studio/plugin_config/obs-websocket/config.json')
    let j = null
    let created = false
    if (fs.existsSync(cfg)) {
      try { j = JSON.parse(fs.readFileSync(cfg, 'utf8')) } catch (e) { j = null }
    }
    let needWrite = false
    if (!j || typeof j !== 'object') {
      const pw = 'zt-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36)
      j = {
        alerts_enabled: false,
        auth_required: true,
        first_load: false,
        server_enabled: true,
        server_password: pw,
        server_port: 4455,
      }
      created = true
      needWrite = true
    } else {
      if (j.server_enabled !== true) { j.server_enabled = true; needWrite = true } // 原来是关闭 → 启用
      j.server_port = j.server_port || 4455
      if (!j.server_password) j.server_password = 'zt-' + Math.random().toString(36).slice(2, 10)
    }
    if (needWrite) {
      fs.writeFileSync(cfg, JSON.stringify(j, null, 2), 'utf8')
      return { ok: true, note: created ? '生成 obs-websocket 配置并启用服务' : '已启用 obs-websocket 服务' }
    }
    return { ok: true, note: 'obs-websocket 服务已开启' }
  } catch (e) {
    return { ok: false, error: '启用 obs-websocket 服务失败：' + ((e && e.message) || e) }
  }
}

// 按显卡厂商选录制硬件编码器：NVIDIA→NVENC、AMD→AMF、Intel→QSV、无独显/核显→x264(CPU)。
// 用 Electron app.getGPUInfo('basic') 读 gpuDevice 的 vendorId 判断厂商（0x10DE=NVIDIA / 0x1002=AMD / 0x8086=Intel）。
async function detectEncoderId() {
  let vendor = ''
  try {
    const { app } = require('electron')
    if (app && app.getGPUInfo) {
      const info = await app.getGPUInfo('basic')
      const devs = (info && info.gpuDevice) || []
      const vendors = new Set()
      for (const d of devs) {
        const s = String(d.vendorId == null ? '' : d.vendorId).trim().toLowerCase()
        let v = 0
        if (/^0x/.test(s)) v = parseInt(s, 16)
        else if (/^\d+$/.test(s)) v = parseInt(s, 10)
        if (v === 0x10de) vendors.add('nvidia')
        else if (v === 0x1002) vendors.add('amd')
        else if (v === 0x8086) vendors.add('intel')
      }
      if (vendors.has('nvidia')) vendor = 'nvidia'
      else if (vendors.has('amd')) vendor = 'amd'
      else if (vendors.has('intel')) vendor = 'intel'
    }
  } catch (e) { /* 读不到就当无独显，用 CPU */ }
  switch (vendor) {
    case 'nvidia': return { id: 'obs_nvenc_h264_tex', name: 'NVIDIA NVENC', vendor: 'nvidia' }
    // AMD：必须用新版 h264_texture_amf（OBS 28+ 随 obs-amf 插件重写，只注册 texture 变体；
    // 老的 obs_amf_h264 已移除，写它起录直接弹「启动输出失败」。旧版 OBS 只有老 ID 的情况由
    // 起录前的编码器自检（ensureRecEncoderWorks）从真实清单里换掉，这里只保证默认值正确）。
    case 'amd': return { id: 'h264_texture_amf', name: 'AMD AMF', vendor: 'amd' }
    case 'intel': return { id: 'obs_qsv_h264', name: 'Intel QSV', vendor: 'intel' }
    default: return { id: 'obs_x264', name: 'x264 (CPU)', vendor: 'cpu' }
  }
}

// 把要用的录制编码器写进 OBS 配置 [AdvOut].RecEncoder（Advanced 输出模式真正生效的键）。
// 必须在 OBS 启动前写好，OBS 一起动即读到。只改 [AdvOut]（录制走 Advanced 模式），SimpleOutput 无需动。
function setRecEncoderIni(encoderId) {
  try {
    const root = obsConfigRoot()
    const profiles = path.join(root, 'basic', 'profiles')
    if (!fs.existsSync(profiles)) return { ok: true, note: 'no profiles dir' }
    let changed = 0
    for (const dir of fs.readdirSync(profiles)) {
      const ini = path.join(profiles, dir, 'basic.ini')
      if (!fs.existsSync(ini)) continue
      const lines = fs.readFileSync(ini, 'utf8').split(/\r?\n/)
      let inAdvOut = false
      let changedThis = false
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*\[/.test(lines[i])) inAdvOut = /^\s*\[AdvOut\]/.test(lines[i])
        if (inAdvOut && /^\s*RecEncoder\s*=/.test(lines[i])) {
          const cur = lines[i].split('=')[1].trim()
          if (cur !== encoderId) { lines[i] = lines[i].replace(/=.*/, '=' + encoderId); changedThis = true }
        }
      }
      if (changedThis) { fs.writeFileSync(ini, lines.join('\n'), 'utf8'); changed++ }
    }
    return changed ? { ok: true, note: 'RecEncoder → ' + encoderId } : { ok: true, note: 'RecEncoder 已是 ' + encoderId }
  } catch (e) {
    return { ok: false, error: '改录制编码器失败：' + ((e && e.message) || e) }
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
  'D:/Program Files/obs-studio/bin/64bit/obs64.exe',
]

function expandEnvVars(p) {
  return p
    .replace(/%ProgramFiles\(x86\)%/gi, process.env['ProgramFiles(x86)'] || '')
    .replace(/%ProgramFiles%/gi, process.env.ProgramFiles || '')
    .replace(/%LOCALAPPDATA%/gi, process.env.LOCALAPPDATA || '')
}

// 扫描所有盘符下常见的 OBS 安装目录（覆盖 C 盘之外的非标准安装，如 D:\Program Files\obs-studio）。
// 只返回候选路径，实际是否存在由调用方用 fs.existsSync 判定；不存在的盘符 existsSync 直接 false，零开销。
function scanObsDrives() {
  const out = []
  const drives = ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z']
  for (const d of drives) {
    for (const pf of ['Program Files', 'Program Files (x86)']) {
      out.push(path.join(d + ':/', pf, 'obs-studio', 'bin', '64bit', 'obs64.exe'))
    }
  }
  return out
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
  // 3) 首次：搜索常见路径 + 扫描所有盘符的 Program Files（非标准安装也找得到），找到即固化，下次不再搜
  const searchPaths = [
    ...OBS_SEARCH_PATHS.map((raw) => expandEnvVars(raw)),
    ...scanObsDrives(),
  ]
  for (const p of searchPaths) {
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
// OBS 32+ 用 .sentinel/run_<uuid> 标记一次运行：正常退出时删除，崩溃/被强杀会残留。
// 下次启动发现残留就弹「上次异常退出 → 安全模式」对话框等人点，自动化起录会卡死在对话框（websocket 起不来）。
// 我们自己拉起 OBS 前清掉残留（此刻确认没有 OBS 进程在跑，删的是死哨兵），保证冷启动不被弹窗挡住。
function clearObsSentinel() {
  try {
    const dir = path.join(obsConfigRoot(), '.sentinel')
    if (!fs.existsSync(dir)) return false
    let n = 0
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f)
      try { fs.unlinkSync(fp); n++ } catch (e) {}
    }
    if (n) console.log('[obsRecorder] 已清理 OBS 异常退出哨兵 ' + n + ' 个（防止安全模式弹窗卡住自动起录）')
    return n > 0
  } catch (e) {
    return false
  }
}

async function ensureOBSRunning({ timeoutMs = 30000, pollMs = 1000, forceEncoder } = {}) {
  if (connected && obs) return { ok: true, reused: true }

  const first = await connect()
  if (first.ok) return first

  // 没连上：多半是 OBS 没跑。先确认没有 OBS 进程在跑，避免重复拉起。
  const ex = await resolveObsExe()
  if (!ex.ok) return ex

  if (!isObsRunning()) {
    // OBS 未运行才改 INI（运行时改无效）：先写色阶 Full，OBS 一起动即读到（见 ensureColorRangeFullInIni 注释）。
    try { const r = ensureColorRangeFullInIni(); if (r && r.note) console.log('[obsRecorder] 色阶：', r.note) } catch (e) {}
    // 确保 obs-websocket 服务启用（默认关闭 → 连不上）：在 OBS 启动前写好，OBS 一起动即开启
    try { const r = ensureObsWebsocketEnabled(); if (r && r.note) console.log('[obsRecorder] WebSocket：', r.note) } catch (e) {}
    // 选定录制硬件编码器（NVENC/AMF/QSV，回退 x264）：自检修复重拉时用 forceEncoder 强制指定已确认可用的 ID。
    // RecEncoder 与编码器质控参数（recordEncoder.json）都必须在 OBS 启动前写好，OBS 一起动即读到。
    // 优先复用上次自检确认可用的编码器（lastEncoderId）：若每次冷启动都重新探测，探测结果一旦与
    // 本机 OBS 实际清单有出入，ensureRecEncoderWorks 会杀掉刚拉起的 OBS 重启修复——
    // 而 stop 后 OBS 本就会被关闭，结果就是「每次录制 OBS 都关闭再重启一次」。
    try {
      const enc = forceEncoder || (lastEncoderId
        ? { id: lastEncoderId, vendor: lastVendor, name: lastEncoder }
        : (persistedEncoder() || await detectEncoderId()))
      lastEncoderId = enc.id
      lastVendor = enc.vendor
      lastEncoder = enc.name
      const r = setRecEncoderIni(enc.id)
      if (r && r.note) console.log('[obsRecorder] 编码器：', enc.name + ' (' + enc.id + ') · ' + r.note)
      // 录制编码器高清参数（真参在 recordEncoder.json）：按本次编码器的参数形状写（AMF→CQP/cqp，其余→CRF/crf）
      try {
        const q = ensureRecordEncoderJson({ encoderId: enc.id })
        if (q && q.changed && q.note) console.log('[obsRecorder] 编码器参数已抬高清：', q.note)
      } catch (e) {}
    } catch (e) { console.log('[obsRecorder] 编码器检测失败：', (e && e.message) || e) }
    // 清异常退出哨兵：崩溃/被强杀后的残留会让 OBS 弹安全模式框卡住启动（见 clearObsSentinel）
    try { clearObsSentinel() } catch (e) {}
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
const HD_BITRATE_KBPS = 30000   // 1080p 高清档（清晰度优先，固定码率上限）。上到 30M 后细文字/描边基本无可见压缩块。
const HD_CRF = 12               // 可接受的最高 CRF/CQP：数值越大越糊，超过该值（如 OBS 默认 23）会肉眼可见发糊，此时抬回此值。
                                // 2026-09 用户只在乎清晰度不在乎文件大小 → 定为 12：静态页面近无损，动画/focus-zoom 片段瞬时质量也足。

// 目标码率：基于录制分辨率线性缩放（1080p ≈ 30Mbps 起，越清晰越好；上限 60M 防文件过大）。
function targetBitrate(width, height) {
  const w = width || 1920, h = height || 1080
  const px = (w * h) / (1920 * 1080) // 相对 1080p 的倍数
  const kbps = Math.round(HD_BITRATE_KBPS * px)
  return Math.max(HD_BITRATE_KBPS, Math.min(60000, kbps))
}

// 录制画质兜底：真正生效的录制编码器参数在 profile 目录的 recordEncoder.json
//（rate_control/crf/cqp/bitrate），不在 basic.ini 的 [AdvOut]（哪里的 Recbitrate/RecCRF 键不存在，
// 之前用 SetProfileParameter 改那里是无效的）。这里直接委托给 ensureRecordEncoderJson()（
// 已在 OBS 启动前调用过，这里再确认一次并收集说明）。
async function ensureRecordQuality(opts) {
  // 编码器质控：CRF/CQP 过大(糊)或 CBR/VBR 码率过低时升到高清档（只升不降），按录制分辨率缩放目标码率
  // 只在真的改了配置时才回传 note（changed）——没改（用户已是高清档）就不打扰 UI。
  const r = ensureRecordEncoderJson(opts)
  return r && r.ok && r.changed && r.note ? [r.note] : []
}

// ---------------------------------------------------------------------------
// 编码器可用性自检（防止「启动输出失败」弹窗）
// ---------------------------------------------------------------------------
//
// 背景：OBS 的录制编码器 ID 随版本/驱动变化 —— 例如 AMD 在 OBS 28+ 只注册新 ID h264_texture_amf，
// 老的 obs_amf_h264 已随旧插件移除；NVENC/QSV 也有同样迁移。若 profile 的 [AdvOut].RecEncoder 写的 ID
// 不存在于当前 OBS，起录时 OBS 弹「启动录像失败/启动输出失败」且不落任何 start-record 日志，
// 用户根本无从排查（提示里只会怪 NVENC/AMD 驱动，而实际是配置写错）。
//
// 自检原理：OBS 启动加载 profile 时若发现 RecEncoder 不存在，会在会话日志里写一行
//   Encoder ID 'xxx' not found
// 并在同一段日志给出当前真实可用的编码器清单（Available Encoders）。这两段在 websocket 起来前就写完，
// 连上后读必然完整。检测到不匹配 → 从真实清单里选一个可用 ID（同显卡厂商优先、x264 兑底）→
// 重写所有 profile 的 RecEncoder → 优雅重启 OBS（配置只在启动时读进内存，运行中改无效）。

// OBS 会话日志目录（obs-studio/logs），文件名形如 "2026-09-03 17-59-30.txt"
function obsLogsDir() {
  return path.join(obsConfigRoot(), 'logs')
}

// 当前运行实例的会话日志 = logs 目录里最新写入的 .txt（OBS 每个实例一个文件，日志持续追加）
function newestObsLog() {
  try {
    const dir = obsLogsDir()
    let best = ''
    let bestT = 0
    for (const f of fs.readdirSync(dir)) {
      if (!/\.txt$/i.test(f)) continue
      const fp = path.join(dir, f)
      let s
      try { s = fs.statSync(fp) } catch (e) { continue }
      if (s.mtimeMs > bestT) { bestT = s.mtimeMs; best = fp }
    }
    return best
  } catch (e) {
    return ''
  }
}

// 解析会话日志：①真实注册的视频编码器 ID 清单（Available Encoders → Video Encoders 段）
// ②启动时加载 profile 失败的编码器 ID（"Encoder ID 'xxx' not found"）。
// 返回 { ids: [...], missing: [...] }，解析不出就返回空数组（调用方按"不干预"处理）。
function parseEncoderLog(text) {
  const ids = []
  const missing = []
  const lines = String(text || '').split(/\r?\n/)
  let inVideo = false
  for (const line of lines) {
    const miss = line.match(/Encoder ID '([^']+)' not found/)
    if (miss && missing.indexOf(miss[1]) < 0) missing.push(miss[1])
    if (/Video Encoders:/.test(line)) { inVideo = true; continue }
    if (/Audio Encoders:/.test(line)) { inVideo = false; continue }
    if (!inVideo) continue
    // OBS 日志每行带 "HH:MM:SS.mmm: " 时间戳前缀，编码器行形如 "\t- h264_texture_amf (...)"，须先剥前缀
    const bare = line.replace(/^\d{2}:\d{2}:\d{2}\.\d{3}:\s*/, '')
    const m = bare.match(/^\s*-\s+(\S+)/)
    if (m && ids.indexOf(m[1]) < 0) ids.push(m[1])
  }
  return { ids, missing }
}

// 读所有 profile 的 [AdvOut].RecEncoder 现值（我们启动前会给每个 profile 写同值，因此任一值与实例清单不符
// 都说明起录会失败；只用于判断「not found 的是不是录制编码器」，避免把流编码器的 not found 误判成我们的问题）
function recEncoderValuesInProfiles() {
  const vals = []
  try {
    const profiles = path.join(obsConfigRoot(), 'basic', 'profiles')
    for (const dir of fs.readdirSync(profiles)) {
      const ini = path.join(profiles, dir, 'basic.ini')
      if (!fs.existsSync(ini)) continue
      const lines = fs.readFileSync(ini, 'utf8').split(/\r?\n/)
      let inAdvOut = false
      for (const line of lines) {
        if (/^\s*\[/.test(line)) inAdvOut = /^\s*\[AdvOut\]/.test(line)
        if (inAdvOut && /^\s*RecEncoder\s*=/.test(line)) {
          const v = line.split('=')[1].trim()
          if (v && vals.indexOf(v) < 0) vals.push(v)
        }
      }
    }
  } catch (e) { /* 读不到就按无 RecEncoder 处理（不触发自检） */ }
  return vals
}

// 起录前编码器自检：发现当前 OBS 不认 profile 里写的 RecEncoder → 改成真实可用的编码器并重启 OBS。
// 健康时零开销（读一次日志文件）；修不动时返回 ok:false 把根因亮给用户。
async function ensureRecEncoderWorks() {
  try {
    const log = newestObsLog()
    if (!log) return { ok: true, note: '无 OBS 会话日志，跳过编码器自检' }
    // 日志落盘有个极短窗口，轮询到出现 Available Encoders 段为止
    let text = ''
    for (let i = 0; i < 25 && text.indexOf('Available Encoders') < 0; i++) {
      try { text = fs.readFileSync(log, 'utf8') } catch (e) { text = '' }
      if (text.indexOf('Available Encoders') < 0) await wait(200)
    }
    const parsed = parseEncoderLog(text)
    // 只有「not found 的编码器 == 我们写的 RecEncoder」才需要修（避免误伤用户流编码器配置）
    const profileVals = recEncoderValuesInProfiles()
    const badOnes = parsed.missing.filter((id) => profileVals.indexOf(id) >= 0)
    if (!badOnes.length) {
      // 当前写的 RecEncoder 在本机 OBS 里确认可用 → 记住它，之后冷启动不再重新探测
      if (lastEncoderId) persistObsEncoder(lastEncoderId)
      return { ok: true, note: '录制编码器在当前 OBS 可用' }
    }
    if (!parsed.ids.length) return { ok: true, note: '日志里没有编码器清单，交给 StartRecord 原样报错' }
    // 从真实清单里挑：本机显卡厂商的硬件编码器优先（按新旧 ID 序），其它厂商次之，x264 兑底
    let vendor = lastVendor
    if (!vendor || vendor === 'cpu') {
      try { vendor = (await detectEncoderId()).vendor } catch (e) {}
    }
    const order = []
    for (const v of [vendor, 'nvidia', 'amd', 'intel', 'cpu']) {
      for (const id of ENCODER_IDS_BY_VENDOR[v] || []) {
        if (order.indexOf(id) < 0) order.push(id)
      }
    }
    const pick = order.find((id) => parsed.ids.indexOf(id) >= 0)
    if (!pick) {
      return {
        ok: false,
        error: 'OBS 可用编码器清单里找不到可用的 H.264 录制编码器（清单：' + parsed.ids.join('、') + '）。\n' +
          '请把显卡驱动更新到最新后重试（若仍不行可在 OBS 里把录制编码器手动改成任意一个可用的，工具会沿用）。',
      }
    }
    console.log('[obsRecorder] 编码器自检：', badOnes.join('/'), '在当前 OBS 不可用 → 改用', pick, '并重启 OBS 生效')
    const r = setRecEncoderIni(pick)
    if (r && !r.ok) return r
    lastEncoderId = pick
    lastVendor = vendor
    lastEncoder = encoderLabel(pick)
    persistObsEncoder(pick) // 记住修好的结果：之后冷启动直接用，不再进入修复重启
    await killOBS() // 优雅退出（带 /F 兜底），确保旧实例释放配置后再拉新的
    await wait(300)
    const rr = await ensureOBSRunning({ forceEncoder: { id: pick, name: encoderLabel(pick), vendor } })
    if (!rr.ok) {
      return { ok: false, error: '已把录制编码器修正为 ' + encoderLabel(pick) + '，但重启 OBS 失败：' + (rr.error || '') }
    }
    return { ok: true, repaired: pick }
  } catch (e) {
    // 自检/修复本身出意外时不挡录屏主流程，让 StartRecord 原样报错（与修复前行为一致）
    return { ok: true, note: '编码器自检异常跳过：' + ((e && e.message) || e) }
  }
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
  // 编码器自检：RecEncoder 不存在于当前 OBS 时（版本/驱动换代导致 ID 变更）起录必弹「启动输出失败」。
  // 检测到就把配置改成当前实例真实可用的编码器并重启 OBS，一切自动，不让用户在 OBS 里手工配。
  const chk = await ensureRecEncoderWorks()
  if (!chk.ok) return chk
  // 自检做过「改编码器 + 重启 OBS」的修复时，回传给编辑器显示（否则用户只看到 OBS 闪退重启、一头雾水）
  const repairNote = chk.repaired ? '录制编码器自检修正为 ' + encoderLabel(chk.repaired) : ''
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
      const maxW = parseInt(a.maxWidth || process.env.OBS_MAX_WIDTH || 3840, 10)
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
      // 录制画质兜底（只升不降）：1080p 下码率过低/CRF 过高会明显发糊。
      // 参数形状随编码器走：AMF 只认 CQP/cqp（见 ensureRecordEncoderJson）
      const qnotes = await ensureRecordQuality({ width: w, height: h, encoderId: lastEncoderId })
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
      encoder: lastEncoder,
      window: 'OBS 浏览器源',
      captureMode: a.captureMode,
      outdir,
      fit,
      audio,
      health,
      quality: qualityNotes,
      repair: repairNote,
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
  // 是否真的下发过 StopRecord。用于区分两种 skipped：
  //   没下发（outputActive 为假）→ 本来就没在录，良性；
  //   下发过但文件没拿到/没稳定 → OBS 可能仍在写盘，此时绝不能强杀进程
  //   （taskkill /F 会让 MP4 缺 moov 头，成片彻底不可播放）。
  let didStop = false
  try {
    const st = await o.call('GetRecordStatus')
    if (!st.outputActive) return { ok: true, filePath: '', skipped: true, stopped: false }

    await o.call('StopRecord')
    didStop = true

    // 等 OBS 真正收尾：固定 sleep 不够（大文件收尾/remux 更久）。
    // 提前读会拿到残缺文件 → 播放器只能解出第一帧：画面静止、没声音、进度条却在走。
    // 4K/60Mbps 长片的 remux 远超 10s，这里放宽到 60s，避免收不完就被判定失败。
    for (let i = 0; i < 120; i++) {
      await wait(500)
      const s = await o.call('GetRecordStatus')
      if (!s.outputActive) break
    }
    await wait(800)

    // 等文件大小不再增长，确认 OBS 已写完（含 mp4 remux）
    // 默认上限 10s 对 4K 远远不够（60Mbps 一分钟就有 450MB，remux 要重写整个文件），放宽到 60s。
    const waitStable = async (fp, maxMs = 60000) => {
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
      if (r) return Object.assign(r, { stopped: true })
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
      if (r) return Object.assign(r, { stopped: true })
    }
    // 走到这里说明 StopRecord 已下发，但文件迟迟没稳定（或根本没找到）。
    // 关键：返回 ok:false 而不是 ok:true+skipped。之前返回 ok:true 会让上层误判为
    // 「正常停止」并直接 killOBS 强杀 OBS，导致 MP4 缺 moov 头、成片全损。
    // 现在明确告诉上层「文件还没收尾」，由上层跳过强杀并提示用户去 OBS 手动停止。
    return {
      ok: false,
      stopped: true,
      filePath: '',
      dir: dir || '',
      error: '录制已停止，但输出文件在 60s 内未写完/未找到。为防损坏成片，未关闭 OBS，请在 OBS 中确认文件已生成后再手动关闭。',
    }
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e)
    // 异常同样可能发生在 StopRecord 之后（如收尾轮询中连接断开），
    // 此时 OBS 仍在写盘，绝不能强杀，故一并带上 didStop 供上层判断。
    return { ok: false, stopped: didStop, error: 'OBS 停止录制失败：' + msg }
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
